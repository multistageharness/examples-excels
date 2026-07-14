#!/usr/bin/env bash
# xlsx2tsv.sh -- the reader. Dump a sheet, a named table, or a month of an .xlsx as TSV.
#
#   xlsx2tsv.sh BOOK.xlsx --list                    # sheet names, one per line
#   xlsx2tsv.sh BOOK.xlsx --layout                  # named-tables | sheets | none
#   xlsx2tsv.sh BOOK.xlsx --sheet Jan               # that sheet, whole grid
#   xlsx2tsv.sh BOOK.xlsx --month Jan               # that MONTH, resolved per the layout rule
#   xlsx2tsv.sh BOOK.xlsx --month Jan --table-prefix tbl_
#
# --month is the one the diff uses. Two layouts, tried in this order and NEVER mixed:
#
#   1. named Excel Tables  tbl_Jan..tbl_Dec  -- the canonical layout, and the only one Power
#      Query can read, since Excel.CurrentWorkbook() sees named tables and nothing else. The
#      table carries its own ref range, so it need not start at A1 and its sheet may be called
#      anything at all.
#   2. plain sheets  Jan..Dec, header in row 1 -- the fallback, used ONLY when no named table
#      matched any month.
#
# Two things a naive `grep <v>` gets wrong, and this does not: shared strings (a t="s" cell
# holds an INDEX into sharedStrings.xml, not a value) and sparse cells (a blank cell is simply
# absent from the XML, so reading positionally shifts every row after the first gap).

set -euo pipefail

WB="${1:?usage: xlsx2tsv.sh BOOK.xlsx (--list | --layout | --sheet NAME | --month NAME)}"
shift
MODE=""
NAME=""
PREFIX="tbl_"
MONTHS="Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"

while [ $# -gt 0 ]; do
  case "$1" in
    --list)   MODE=list;   shift ;;
    --layout) MODE=layout; shift ;;
    --sheet)  MODE=sheet;  NAME="${2:?--sheet needs a name}";  shift 2 ;;
    --month)  MODE=month;  NAME="${2:?--month needs a name}";  shift 2 ;;
    --table-prefix) PREFIX="${2:?--table-prefix needs a value}"; shift 2 ;;
    *) echo "xlsx2tsv: unknown option $1" >&2; exit 1 ;;
  esac
done
[ -n "$MODE" ] || { echo "xlsx2tsv: pass --list, --layout, --sheet NAME, or --month NAME" >&2; exit 1; }
[ -f "$WB" ] || { echo "xlsx2tsv: No such workbook: $WB" >&2; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
unzip -qq -o "$WB" -d "$TMP/x" 2>/dev/null \
  || { echo "xlsx2tsv: could not open $(basename "$WB") as an .xlsx workbook" >&2; exit 1; }

X="$TMP/x"
unescape() { sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&apos;/'/g" -e 's/&amp;/\&/g'; }

# --- sheet name -> sheet part ---------------------------------------------------------
sed 's|<sheet |\
<sheet |g' "$X/xl/workbook.xml" | awk '
  /^<sheet / {
    if (match($0, /name="[^"]*"/)) n = substr($0, RSTART+6, RLENGTH-7)
    if (match($0, /r:id="[^"]*"/)) r = substr($0, RSTART+6, RLENGTH-7)
    print r "\t" n
  }' | unescape > "$TMP/sheets"

sed 's|<Relationship |\
<Relationship |g' "$X/xl/_rels/workbook.xml.rels" | awk '
  /^<Relationship / {
    if (match($0, /Id="[^"]*"/))     id = substr($0, RSTART+4, RLENGTH-5)
    if (match($0, /Target="[^"]*"/)) t  = substr($0, RSTART+8, RLENGTH-9)
    sub(/^\/?xl\//, "", t); print id "\t" t
  }' > "$TMP/rels"

# name<TAB>part
awk -F'\t' 'NR == FNR { r[$1] = $2; next } ($1 in r) { print $2 "\t" r[$1] }' \
  "$TMP/rels" "$TMP/sheets" > "$TMP/sheetparts"

if [ "$MODE" = list ]; then cut -f1 "$TMP/sheetparts"; exit 0; fi

sheet_part_for() {  # sheet name (case-insensitive) -> part path
  awk -F'\t' -v s="$1" 'tolower($1) == tolower(s) { print $2; exit }' "$TMP/sheetparts"
}

# --- named tables: displayName -> sheet part + ref range -------------------------------
# A table lives on a sheet, but the link runs the other way: each worksheet's rels point at
# the table parts on it. So walk the worksheets, not the tables.
: > "$TMP/tables"
if [ -d "$X/xl/tables" ]; then
  while IFS="$(printf '\t')" read -r sname spart; do
    relf="$X/xl/$(dirname "$spart")/_rels/$(basename "$spart").rels"
    [ -f "$relf" ] || continue
    sed 's|<Relationship |\
<Relationship |g' "$relf" | awk '/^<Relationship / && /table/ {
        if (match($0, /Target="[^"]*"/)) { t = substr($0, RSTART+8, RLENGTH-9); print t }
      }' | while read -r tgt; do
        # A rel Target may be package-absolute (/xl/tables/t1.xml -- what openpyxl writes) or
        # relative to the sheet part (../tables/t1.xml -- what Excel writes). Handle both.
        case "$tgt" in
          /*)   tpath="$X$tgt" ;;
          ../*) tpath="$X/xl/${tgt#../}" ;;
          *)    tpath="$X/xl/$(dirname "$spart")/$tgt" ;;
        esac
        [ -f "$tpath" ] || continue
        awk -v sp="$spart" '
          match($0, /displayName="[^"]*"/) { dn = substr($0, RSTART+13, RLENGTH-14) }
          match($0, /ref="[^"]*"/)         { rf = substr($0, RSTART+5, RLENGTH-6) }
          END { if (dn != "") print dn "\t" sp "\t" rf }' "$tpath" >> "$TMP/tables"
      done
  done < "$TMP/sheetparts"
fi

table_row_for() {  # table displayName (case-insensitive) -> "part<TAB>ref"
  awk -F'\t' -v n="$1" 'tolower($1) == tolower(n) { print $2 "\t" $3; exit }' "$TMP/tables"
}

# The layout is decided ONCE, across all months: named tables win if ANY month matched one.
layout() {
  for m in $MONTHS; do
    [ -n "$(table_row_for "${PREFIX}${m}")" ] && { echo named-tables; return; }
  done
  for m in $MONTHS; do
    [ -n "$(sheet_part_for "$m")" ] && { echo sheets; return; }
  done
  echo none
}

if [ "$MODE" = layout ]; then layout; exit 0; fi

# --- shared strings -------------------------------------------------------------------
SS="$TMP/sst"; : > "$SS"
if [ -f "$X/xl/sharedStrings.xml" ]; then
  sed 's|<si>|\
<si>|g' "$X/xl/sharedStrings.xml" | awk '
    /^<si>/ {
      s = $0; sub(/<\/si>.*/, "", s); out = ""
      while (match(s, /<t[^>]*>[^<]*<\/t>/)) {
        seg = substr(s, RSTART, RLENGTH); sub(/<t[^>]*>/, "", seg); sub(/<\/t>/, "", seg)
        out = out seg; s = substr(s, RSTART + RLENGTH)
      }
      print out
    }' | unescape > "$SS"
fi

# --- dump a sheet part, optionally clipped to a table's ref range ----------------------
dump() {  # $1 = sheet part, $2 = ref range ("" for the whole sheet)
  sed 's|<c |\
<c |g' "$X/xl/$1" | awk -v SSFILE="$SS" -v REF="$2" '
    function colnum(s,   i, n) {
      n = 0
      for (i = 1; i <= length(s); i++) n = n * 26 + index("ABCDEFGHIJKLMNOPQRSTUVWXYZ", substr(s, i, 1))
      return n
    }
    BEGIN {
      while ((getline line < SSFILE) > 0) sst[nss++] = line
      r1 = 0
      if (REF != "" && match(REF, /^[A-Z]+[0-9]+:[A-Z]+[0-9]+$/)) {
        split(REF, P, ":")
        a = P[1]; b = P[2]
        al = a; sub(/[0-9]+$/, "", al); ar = a; sub(/^[A-Z]+/, "", ar)
        bl = b; sub(/[0-9]+$/, "", bl); br = b; sub(/^[A-Z]+/, "", br)
        c1 = colnum(al); r1 = ar + 0; c2 = colnum(bl); r2 = br + 0
      }
    }
    /^<c / {
      ref = ""; typ = ""; val = ""
      if (match($0, /r="[A-Z]+[0-9]+"/)) ref = substr($0, RSTART+3, RLENGTH-4)
      if (ref == "") next
      if (match($0, /t="[^"]*"/)) typ = substr($0, RSTART+3, RLENGTH-4)
      if (typ == "inlineStr") {
        if (match($0, /<t[^>]*>[^<]*<\/t>/)) { val = substr($0, RSTART, RLENGTH); sub(/<t[^>]*>/, "", val); sub(/<\/t>/, "", val) }
      } else if (match($0, /<v>[^<]*<\/v>/)) {
        val = substr($0, RSTART+3, RLENGTH-7)
      }
      if (typ == "s" && val != "") val = sst[val + 0]

      letters = ref; sub(/[0-9]+$/, "", letters)
      rownum  = ref; sub(/^[A-Z]+/, "", rownum)
      r = rownum + 0; c = colnum(letters)
      if (r1 && (r < r1 || r > r2 || c < c1 || c > c2)) next   # outside the table
      cell[r, c] = val
      if (r > maxrow) maxrow = r
      if (c > maxcol) maxcol = c
    }
    END {
      lo_r = r1 ? r1 : 1; hi_r = r1 ? r2 : maxrow
      lo_c = r1 ? c1 : 1; hi_c = r1 ? c2 : maxcol
      for (r = lo_r; r <= hi_r; r++) {
        line = ""
        for (c = lo_c; c <= hi_c; c++) line = line ((r, c) in cell ? cell[r, c] : "") (c < hi_c ? "\t" : "")
        print line
      }
    }' | unescape
}

if [ "$MODE" = sheet ]; then
  part=$(sheet_part_for "$NAME")
  [ -n "$part" ] || { echo "xlsx2tsv: no sheet named '$NAME' in $(basename "$WB")" >&2; exit 1; }
  dump "$part" ""
  exit 0
fi

# --month: resolve through the layout rule
case "$(layout)" in
  named-tables)
    row=$(table_row_for "${PREFIX}${NAME}")
    [ -n "$row" ] || { echo "xlsx2tsv: no table named '${PREFIX}${NAME}'" >&2; exit 1; }
    part=$(printf '%s' "$row" | cut -f1)
    ref=$(printf '%s' "$row" | cut -f2)
    dump "$part" "$ref"
    ;;
  sheets)
    part=$(sheet_part_for "$NAME")
    [ -n "$part" ] || { echo "xlsx2tsv: no sheet named '$NAME'" >&2; exit 1; }
    dump "$part" ""
    ;;
  *)
    echo "xlsx2tsv: $(basename "$WB") has no month tables or sheets" >&2; exit 1 ;;
esac
