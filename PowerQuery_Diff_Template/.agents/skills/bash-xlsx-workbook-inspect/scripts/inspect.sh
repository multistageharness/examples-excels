#!/usr/bin/env bash
# inspect.sh -- is this workbook diffable? Report the layout, months, key, and the quiet hazards.
#
#   inspect.sh WORKBOOK.xlsx [-k KEY]
#
# Exit 0 = diffable. Exit 1 = not, and the reason is printed. Warnings are legal-but-surprising
# findings (gaps, duplicate keys, null keys, ragged columns) and do NOT fail the run.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
READER="$HERE/../../bash-xlsx-diff-commons/scripts/xlsx2tsv.sh"

KEY=ID
WB=""
while [ $# -gt 0 ]; do
  case "$1" in
    -k|--key) KEY="${2:?-k needs a column}"; shift 2 ;;
    -*) echo "inspect: unknown option $1" >&2; exit 1 ;;
    *) WB="$1"; shift ;;
  esac
done
[ -n "$WB" ] || { echo "usage: inspect.sh WORKBOOK.xlsx [-k KEY]" >&2; exit 1; }
[ -f "$WB" ] || { echo "inspect: No such workbook: $WB" >&2; exit 1; }
[ -x "$READER" ] || { echo "inspect: cannot find the reader at $READER" >&2; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
CAL="Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"

"$READER" "$WB" --list > "$TMP/sheets" || exit 1
LAYOUT=$("$READER" "$WB" --layout)

# Resolve each month through the layout rule -- do NOT gate on the sheet being NAMED after the
# month, because in the canonical layout the table tbl_Jan may sit on a sheet called anything.
FOUND=""
for m in $CAL; do
  if "$READER" "$WB" --month "$m" > "$TMP/m_$m.tsv" 2>/dev/null && [ -s "$TMP/m_$m.tsv" ]; then
    FOUND="$FOUND $m"
  else
    rm -f "$TMP/m_$m.tsv"
  fi
done

echo "workbook : $WB"
echo "layout   : $LAYOUT"
echo "key      : $KEY"

if [ -z "$FOUND" ]; then
  echo "months   : (none)"
  echo
  echo "ERROR No month tables. Expected Excel tables named 'tbl_Jan'...'tbl_Dec',"
  echo "      or sheets named 'Jan'...'Dec'."
  echo "      Sheets present: $(tr '\n' ' ' < "$TMP/sheets")"
  exit 1
fi

echo "months   :$(printf '%s' "$FOUND" | sed 's/^ //;s/ /, /g')"
echo

awk -F'\t' -v KEY="$KEY" -v FOUND="$FOUND" -v CAL="$CAL" -v TMPD="$TMP" '
  function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
  BEGIN {
    nf = split(FOUND, F, " "); nc = split(CAL, C, " ")
    for (i = 1; i <= nc; i++) idx[C[i]] = i
    for (i = 1; i <= nf; i++) have[F[i]] = 1

    printf "%-7s %5s  %-5s %s\n", "Month", "Rows", "Key?", "Columns"
    printf "%-7s %5s  %-5s %s\n", "-------", "-----", "-----", "------------------------------"

    nerr = 0; nwarn = 0; nu = 0
    for (i = 1; i <= nf; i++) {
      m = F[i]; file = TMPD "/m_" m ".tsv"
      if ((getline hdr < file) <= 0) continue
      nh = split(hdr, H, "\t"); kcol = 0; cols = ""
      for (c = 1; c <= nh; c++) {
        H[c] = trim(H[c])
        if (H[c] == "") continue
        if (H[c] == KEY) kcol = c
        cols = cols (cols ? ", " : "") H[c]
        if (H[c] != KEY && !(H[c] in useen)) { useen[H[c]] = 1; union[++nu] = H[c] }
      }
      colsof[m] = cols

      rows = 0; dupes = ""; nulls = 0
      delete seenkey
      while ((getline line < file) > 0) {
        n = split(line, V, "\t"); blank = 1
        for (c = 1; c <= n; c++) { V[c] = trim(V[c]); if (V[c] != "") blank = 0 }
        if (blank) continue                      # spacer row
        rows++
        if (!kcol) continue
        k = (kcol <= n) ? V[kcol] : ""
        if (k == "") { nulls++; continue }
        if (k in seenkey) { if (!(k in reported)) { reported[k] = 1; dupes = dupes (dupes ? ", " : "") k } }
        seenkey[k] = 1
      }
      close(file)

      printf "%-7s %5d  %-5s %s\n", m, rows, (kcol ? "yes" : "NO"), cols
      if (!kcol) err[++nerr] = m ": key column " KEY " is missing (columns: " cols ")."
      if (dupes != "") warn[++nwarn] = m ": duplicate key(s) " dupes " -- the last row wins."
      if (nulls)      warn[++nwarn] = m ": " nulls " row(s) with a null key -- excluded from the diff."
    }

    # A month whose IMMEDIATE predecessor is absent is a base month: the comparison
    # short-circuits rather than reaching further back. This is what silently empties a diff.
    for (i = 1; i <= nf; i++) {
      m = F[i]; j = idx[m]
      if (j > 1 && !(C[j-1] in have) && m != F[1])
        warn[++nwarn] = m ": predecessor " C[j-1] " is absent, so " m " is treated as a base month and contributes no changes."
    }
    if (nf < 2) warn[++nwarn] = "Only " nf " month(s) found -- there is nothing to compare, so the diff will be empty."

    for (i = 2; i <= nf; i++)
      if (colsof[F[i]] != colsof[F[1]]) {
        warn[++nwarn] = "Column sets differ across months (" F[i] " vs " F[1] "); the output carries the union and missing cells are blank."
        break
      }

    print ""
    u = ""
    for (i = 1; i <= nu; i++) u = u (u ? ", " : "") union[i]
    if (u != "") print "columns  : " KEY ", " u "\n"

    for (i = 1; i <= nwarn; i++) print "warn  " warn[i]
    for (i = 1; i <= nerr;  i++) print "ERROR " err[i]

    if (nerr) { print ""; print "Not diffable. Pass -k to name the column that identifies a row."; exit 1 }
    print ""
    printf "OK: diffable (%d month(s) found).\n", nf
  }
' /dev/null
