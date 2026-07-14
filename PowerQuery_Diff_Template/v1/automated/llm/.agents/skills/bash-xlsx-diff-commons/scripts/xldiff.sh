#!/usr/bin/env bash
# xldiff.sh -- month-over-month diff of an .xlsx workbook, in shell + awk. No Python.
#
#   xldiff.sh WORKBOOK.xlsx [-k KEY] [-f table|csv|tsv|json] [--table-prefix tbl_]
#                          [--all] [--detect-modified]
#
# An .xlsx is a ZIP of XML. Unzip it, resolve the shared-string table, flatten each month's
# sheet into a TSV grid, and join consecutive months with awk. Output is byte-identical to
# the Python engine in py-xlsx-diff-commons (see reference/PARITY.md).
#
# Depends on: unzip, sed, awk, sort, cut. Nothing else.

set -euo pipefail

KEY=ID
FMT=table
PREFIX=tbl_
ALL=0
DETECT_MODIFIED=0
WB=""

while [ $# -gt 0 ]; do
  case "$1" in
    -k|--key) KEY="${2:?-k needs a column}"; shift 2 ;;
    -f|--format) FMT="${2:?-f needs a format}"; shift 2 ;;
    --table-prefix) PREFIX="${2:?--table-prefix needs a value}"; shift 2 ;;
    --all) ALL=1; shift ;;
    --detect-modified) DETECT_MODIFIED=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) echo "xldiff: unknown option $1" >&2; exit 1 ;;
    *) WB="$1"; shift ;;
  esac
done

[ -n "$WB" ] || { echo "usage: xldiff.sh WORKBOOK.xlsx [-k KEY] [-f FMT] [--all] [--detect-modified]" >&2; exit 1; }
[ -f "$WB" ] || { echo "xldiff: No such workbook: $WB" >&2; exit 1; }
case "$FMT" in table|csv|tsv|json) ;; *) echo "xldiff: unknown format '$FMT' (table|csv|tsv|json)" >&2; exit 1 ;; esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

unzip -qq -o "$WB" -d "$TMP/x" 2>/dev/null \
  || { echo "xldiff: could not open $(basename "$WB") as an .xlsx workbook" >&2; exit 1; }

TAB=$(printf '\t')
HERE=$(cd "$(dirname "$0")" && pwd)
READER="$HERE/xlsx2tsv.sh"
[ -x "$READER" ] || { echo "xldiff: cannot find the reader at $READER" >&2; exit 1; }

# --- Read every month present -----------------------------------------------------------
# The reader owns the layout rule: named Excel Tables (tbl_Jan..tbl_Dec) first -- the canonical
# layout, which carries its own ref range and may sit on a sheet called anything -- falling back
# to plain sheets named Jan..Dec only when no table matched any month. The two are never mixed.
CAL="Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"
LAYOUT=$("$READER" "$WB" --layout --table-prefix "$PREFIX")
FOUND=""
for m in $CAL; do
  if "$READER" "$WB" --month "$m" --table-prefix "$PREFIX" > "$TMP/m_$m.tsv" 2>/dev/null \
     && [ -s "$TMP/m_$m.tsv" ]; then
    FOUND="$FOUND $m"
  else
    rm -f "$TMP/m_$m.tsv"
  fi
done

[ -n "$FOUND" ] || {
  echo "xldiff: $(basename "$WB") has no month tables. Expected Excel tables named" >&2
  echo "        '${PREFIX}Jan'...'${PREFIX}Dec', or sheets named 'Jan'...'Dec'." >&2
  exit 1
}

# --- 5. The diff ----------------------------------------------------------------------
# Each month is compared to the month IMMEDIATELY before it in the calendar. A month whose
# predecessor is absent has no baseline: it is a Base Month and contributes no changes.
#
# Rows are emitted with a 4-field sort prefix (month, rank, number, text) and ordered by an
# external sort -- awk has no sort, and the ranking has to put numbers before text before
# nulls because a spreadsheet column holds all three and they are not mutually comparable.
diff_rows() {
  awk -F'\t' -v KEY="$KEY" -v ALL="$ALL" -v DM="$DETECT_MODIFIED" -v FOUND="$FOUND" -v TMPD="$TMP" '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function rank(v) {                                  # numbers, then text, then nulls
      if (v == "") return 2
      if (v ~ /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)$/) return 0
      return 1
    }
    # Emit one row. The values always come from LINE under HDRSRC-s header -- never from a
    # lookup -- because a Removed row carries the PREVIOUS month-s values, and a duplicated
    # base-month key must emit each of its own rows.
    function emit(month, key, status, hdrsrc, line, mi, srank, snum,   nh, H, nv, V, c, out, j, nm2) {
      if (!ALL && status != "Added" && status != "Removed" && status != "Modified") return
      nh = split(header[hdrsrc], H, "\t"); nv = split(line, V, "\t")
      delete cell
      for (c = 1; c <= nh; c++) cell[trim(H[c])] = (c <= nv) ? trim(V[c]) : ""
      out = month "\t" key "\t" status
      for (j = 1; j <= ncols; j++) { nm2 = union[j]; out = out "\t" (nm2 in cell ? cell[nm2] : "") }
      printf "%02d\t%d\t%020.6f\t%s\t%s\n", mi, srank, snum, tolower(key), out
    }
    function changed(pm, cm, k,   nh, H, nph, PH, np, P, nc, C, c, d, pc, name, pv, cv) {
      nh  = split(header[cm], H, "\t"); nph = split(header[pm], PH, "\t")
      np  = split(rows[pm, k], P, "\t"); nc = split(rows[cm, k], C, "\t")
      for (c = 1; c <= nh; c++) {
        name = trim(H[c])
        if (name == "" || name == KEY) continue        # the key never counts as a change
        pc = 0
        for (d = 1; d <= nph; d++) if (trim(PH[d]) == name) pc = d
        pv = (pc && pc <= np) ? trim(P[pc]) : ""
        cv = (c <= nc) ? trim(C[c]) : ""
        if (pv != cv) return 1
      }
      return 0
    }
    BEGIN {
      nm = split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", CAL, " ")
      split(FOUND, F, " ")
      ncols = 0

      for (fi in F) {
        m = F[fi]; file = TMPD "/m_" m ".tsv"
        if ((getline hdr < file) <= 0) continue
        have[m] = 1; header[m] = hdr
        nh = split(hdr, H, "\t"); kcol[m] = 0
        for (c = 1; c <= nh; c++) {
          H[c] = trim(H[c])
          if (H[c] == KEY) kcol[m] = c
          # the column union, in first-seen order across months (the key is emitted separately)
          if (H[c] != "" && H[c] != KEY && !(H[c] in seen)) { seen[H[c]] = 1; union[++ncols] = H[c] }
        }
        if (kcol[m] == 0) { missing = missing (missing ? ", " : "") m; continue }

        nrow[m] = 0
        while ((getline line < file) > 0) {
          n = split(line, V, "\t"); blank = 1
          for (c = 1; c <= n; c++) if (trim(V[c]) != "") blank = 0
          if (blank) continue                          # spacer row
          k = (kcol[m] <= n) ? trim(V[kcol[m]]) : ""
          if (k == "") continue                        # null key: not a joinable row
          raw[m, ++nrow[m]] = line                     # file order, duplicates kept
          if (!((m, k) in keyseen)) { keyseen[m, k] = 1; klist[m] = klist[m] " " k }
          rows[m, k] = line                            # duplicate key: the last row wins
        }
        close(file)
      }

      if (missing != "") {
        printf "xldiff: Key column %s is missing from: %s. Pass -k to name the column that identifies a row.\n", "'"'"'" KEY "'"'"'", missing > "/dev/stderr"
        exit 1
      }

      for (i = 1; i <= nm; i++) {
        m = CAL[i]
        if (!(m in have)) continue
        p = (i > 1) ? CAL[i-1] : ""
        base = (p == "" || !(p in have))               # no immediate predecessor => base month

        if (base) {
          # Base-month rows are emitted in FILE order, duplicates and all -- matching the
          # reference engine, which walks the rows rather than the key index here. Every
          # other month joins on the key, so duplicates collapse to last-wins. The asymmetry
          # is the reference-s, and parity means reproducing it.
          for (a = 1; a <= nrow[m]; a++) {
            n = split(raw[m, a], V, "\t")
            k = trim(V[kcol[m]])
            emit(m, k, "Base Month", m, raw[m, a], i, 0, a)
          }
          continue
        }

        n = split(klist[m], K, " ")
        for (a = 1; a <= n; a++) {
          k = K[a]; if (k == "") continue
          if ((m, k) in rows && (p, k) in rows) {
            st = (DM && changed(p, m, k)) ? "Modified" : "Unchanged"
            emit(m, k, st, m, rows[m, k], i, rank(k), (rank(k) == 0 ? k + 0 : 0))
          } else if ((m, k) in rows) {
            emit(m, k, "Added", m, rows[m, k], i, rank(k), (rank(k) == 0 ? k + 0 : 0))
          }
        }

        # Removed: the key was in the previous month and is gone from this one. The row is
        # LABELLED with this month (where the removal was observed) but carries the PREVIOUS
        # month-s values -- the last month it actually existed. This month has nothing to show.
        n = split(klist[p], K, " ")
        for (a = 1; a <= n; a++) {
          k = K[a]; if (k == "") continue
          if (!((m, k) in rows))
            emit(m, k, "Removed", p, rows[p, k], i, rank(k), (rank(k) == 0 ? k + 0 : 0))
        }
      }
    }
  ' /dev/null | sort -t"$TAB" -k1,1n -k2,2n -k3,3 -k4,4 | cut -f5-
}

# The header: Month, the key, Change_Status, then the union of every month-s data columns.
build_header() {
  awk -F'\t' -v KEY="$KEY" -v FOUND="$FOUND" -v TMPD="$TMP" '
    BEGIN {
      split(FOUND, F, " "); ncols = 0
      for (fi in F) {
        file = TMPD "/m_" F[fi] ".tsv"
        if ((getline hdr < file) <= 0) continue
        nh = split(hdr, H, "\t")
        for (c = 1; c <= nh; c++) {
          gsub(/^[ \t]+|[ \t]+$/, "", H[c])
          if (H[c] != "" && H[c] != KEY && !(H[c] in seen)) { seen[H[c]] = 1; union[++ncols] = H[c] }
        }
        close(file)
      }
      out = "Month\t" KEY "\tChange_Status"
      for (j = 1; j <= ncols; j++) out = out "\t" union[j]
      print out
    }' /dev/null
}

HDR=$(build_header)
ROWS=$(diff_rows) || exit 1

case "$FMT" in
  tsv) printf '%s\n' "$HDR"; if [ -n "$ROWS" ]; then printf '%s\n' "$ROWS"; fi ;;

  # RFC-4180: quote anything containing a quote, comma, or newline, and end lines with CRLF
  # -- which is what Python-s csv module emits, so the two outputs stay byte-identical.
  csv) { printf '%s\n' "$HDR"; if [ -n "$ROWS" ]; then printf '%s\n' "$ROWS"; fi; } | awk -F'\t' '{
          out = ""
          for (i = 1; i <= NF; i++) {
            v = $i
            if (v ~ /[",]/ || index(v, "\n")) { gsub(/"/, "\"\"", v); v = "\"" v "\"" }
            out = out (i > 1 ? "," : "") v
          }
          printf "%s\r\n", out
        }' ;;

  # A blank cell is null, and a value that came out of Excel as a number stays a number.
  # (A numeric-looking STRING in the source is the one case this cannot tell apart -- see
  # reference/PARITY.md.)
  json) { printf '%s\n' "$HDR"; if [ -n "$ROWS" ]; then printf '%s\n' "$ROWS"; fi; } | awk -F'\t' '
          function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
          function val(s) {
            if (s == "") return "null"
            if (s ~ /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/) return s
            return "\"" esc(s) "\""
          }
          NR == 1 { for (i = 1; i <= NF; i++) h[i] = $i; nf = NF; next }
          {
            o = "  {"
            for (i = 1; i <= nf; i++) o = o (i > 1 ? "," : "") "\n    \"" esc(h[i]) "\": " val($i)
            obj[++n] = o "\n  }"
          }
          END {
            if (!n) { print "[]"; exit }
            print "["
            for (i = 1; i <= n; i++) printf "%s%s\n", obj[i], (i < n ? "," : "")
            print "]"
          }' ;;

  table) { printf '%s\n' "$HDR"; if [ -n "$ROWS" ]; then printf '%s\n' "$ROWS"; fi; } | awk -F'\t' '
          { for (c = 1; c <= NF; c++) { cell[NR, c] = $c; if (length($c) > w[c]) w[c] = length($c) }
            if (NF > nf) nf = NF; nr = NR }
          END {
            for (r = 1; r <= nr; r++) {
              line = ""
              for (c = 1; c <= nf; c++) line = line sprintf("%-*s%s", w[c], cell[r, c], (c < nf ? "  " : ""))
              sub(/[ \t]+$/, "", line); print line
              if (r == 1) {
                line = ""
                for (c = 1; c <= nf; c++) { d = ""; for (i = 0; i < w[c]; i++) d = d "-"; line = line d (c < nf ? "  " : "") }
                print line
              }
            }
          }' ;;
esac

# A zero-change diff is a legitimate result (see the gap rule), not an error.
exit 0
