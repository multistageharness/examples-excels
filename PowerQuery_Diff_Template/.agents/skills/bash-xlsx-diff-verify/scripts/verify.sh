#!/usr/bin/env bash
# verify.sh -- prove an emitted diff file actually describes the workbook it came from.
#
#   verify.sh SOURCE.xlsx CHANGES.xlsx|.csv|.tsv [-k KEY] [--detect-modified] [--all]
#
# Exit 0 = every check passed. Exit 1 = at least one failed.
#
# Two independent checks, and the distinction is the whole point:
#
#   PARITY     re-run the engine over SOURCE and compare row for row. Catches a stale,
#              truncated, hand-edited, or wrong-workbook file. Does NOT catch an engine bug
#              -- it compares the engine against itself.
#
#   INVARIANT  go back to SOURCE-s raw month sheets and re-derive, WITHOUT the engine, what
#              each emitted row is required to say. This is what catches an engine bug, and
#              the rule it exists for is: a Removed row is LABELLED with the month the removal
#              was observed in, but CARRIES the values from the month BEFORE it -- the last
#              month the row actually existed. Get that backwards and the file still looks
#              entirely plausible. Parity alone would bless it. This refuses to.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
COMMONS="$HERE/../../bash-xlsx-diff-commons/scripts"
READER="$COMMONS/xlsx2tsv.sh"
ENGINE="$COMMONS/xldiff.sh"

KEY=ID
FLAGS=""
SRC=""
EMITTED=""
while [ $# -gt 0 ]; do
  case "$1" in
    -k|--key) KEY="${2:?-k needs a column}"; shift 2 ;;
    --detect-modified|--all) FLAGS="$FLAGS $1"; shift ;;
    -*) echo "verify: unknown option $1" >&2; exit 1 ;;
    *) if [ -z "$SRC" ]; then SRC="$1"; else EMITTED="$1"; fi; shift ;;
  esac
done
[ -n "$SRC" ] && [ -n "$EMITTED" ] || { echo "usage: verify.sh SOURCE.xlsx CHANGES.{xlsx,csv,tsv} [-k KEY] [--detect-modified] [--all]" >&2; exit 1; }
[ -f "$SRC" ] || { echo "verify: No such workbook: $SRC" >&2; exit 1; }
[ -f "$EMITTED" ] || { echo "verify: No such file: $EMITTED" >&2; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
CAL="Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"

# --- read the emitted file back, whatever format it is, as TSV ------------------------
case "$EMITTED" in
  *.xlsx|*.xlsm) "$READER" "$EMITTED" --sheet Changes > "$TMP/actual.tsv" ;;
  *.tsv)         cp "$EMITTED" "$TMP/actual.tsv" ;;
  *.csv)         # unpick RFC-4180 quoting back into TSV
                 tr -d '\r' < "$EMITTED" | awk '
                   { line = $0; out = ""; f = ""; inq = 0
                     for (i = 1; i <= length(line); i++) {
                       ch = substr(line, i, 1)
                       if (inq) {
                         if (ch == "\"") { if (substr(line, i+1, 1) == "\"") { f = f "\""; i++ } else inq = 0 }
                         else f = f ch
                       } else if (ch == "\"") inq = 1
                       else if (ch == ",") { out = out f "\t"; f = "" }
                       else f = f ch
                     }
                     print out f
                   }' > "$TMP/actual.tsv" ;;
  *) echo "verify: don't know how to read $(basename "$EMITTED"); expected .xlsx/.csv/.tsv" >&2; exit 1 ;;
esac

# --- PARITY: what the engine says the answer is --------------------------------------
# shellcheck disable=SC2086
"$ENGINE" "$SRC" -k "$KEY" -f tsv $FLAGS > "$TMP/expected.tsv" || exit 1

# --- read the source months, for the invariant pass ----------------------------------
FOUND=""
for m in $CAL; do
  if "$READER" "$SRC" --month "$m" > "$TMP/m_$m.tsv" 2>/dev/null && [ -s "$TMP/m_$m.tsv" ]; then
    FOUND="$FOUND $m"
  else
    rm -f "$TMP/m_$m.tsv"
  fi
done

DM=0
ALL=0
case "$FLAGS" in *--detect-modified*) DM=1 ;; esac
case "$FLAGS" in *--all*) ALL=1 ;; esac

awk -F'\t' -v KEY="$KEY" -v CAL="$CAL" -v FOUND="$FOUND" -v TMPD="$TMP" -v DM="$DM" -v ALL="$ALL" \
    -v SRC="$SRC" -v EMITTED="$EMITTED" '
  function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
  function fail(msg) { failures[++nf] = msg }
  BEGIN {
    nc = split(CAL, C, " "); for (i = 1; i <= nc; i++) idx[C[i]] = i
    nfound = split(FOUND, F, " "); for (i = 1; i <= nfound; i++) have[F[i]] = 1

    # ---- load the source months (raw, no engine) ----
    for (i = 1; i <= nfound; i++) {
      m = F[i]; file = TMPD "/m_" m ".tsv"
      if ((getline hdr < file) <= 0) continue
      nh = split(hdr, H, "\t"); kc[m] = 0
      for (c = 1; c <= nh; c++) { H[c] = trim(H[c]); if (H[c] == KEY) kc[m] = c; hname[m, c] = H[c] }
      hcount[m] = nh
      while ((getline line < file) > 0) {
        n = split(line, V, "\t"); blank = 1
        for (c = 1; c <= n; c++) { V[c] = trim(V[c]); if (V[c] != "") blank = 0 }
        if (blank || !kc[m]) continue
        k = (kc[m] <= n) ? V[kc[m]] : ""
        if (k == "") continue
        present[m, k] = 1
        for (c = 1; c <= hcount[m]; c++) sval[m, k, hname[m, c]] = (c <= n) ? V[c] : ""
      }
      close(file)
    }

    # ---- PARITY: expected vs actual, as multisets of rendered rows ----
    ef = TMPD "/expected.tsv"; af = TMPD "/actual.tsv"
    if ((getline ehdr < ef) <= 0) ehdr = ""
    if ((getline ahdr < af) <= 0) ahdr = ""
    if (trim(ehdr) != trim(ahdr)) fail("header mismatch:\n      expected: " ehdr "\n      got:      " ahdr)
    while ((getline line < ef) > 0) { want[line]++; ne++ }
    while ((getline line < af) > 0) { gotr[line]++; na++; order[na] = line }
    close(ef); close(af)
    if (ne != na) fail("row count: expected " ne ", got " na)
    for (l in want) if (!(l in gotr) || gotr[l] < want[l]) { nshow++; if (nshow <= 5) fail("row missing from the output: " l) }
    for (l in gotr) if (!(l in want) || want[l] < gotr[l]) { mshow++; if (mshow <= 5) fail("row in the output that the diff does not produce: " l) }

    # ---- INVARIANT: re-derive each emitted row-s claim from the source ----
    nh = split(ahdr, AH, "\t")
    for (c = 1; c <= nh; c++) { AH[c] = trim(AH[c]); acol[AH[c]] = c }
    allowed["Added"] = 1; allowed["Removed"] = 1
    if (DM)  allowed["Modified"] = 1
    if (ALL) { allowed["Unchanged"] = 1; allowed["Base Month"] = 1 }

    for (r = 1; r <= na; r++) {
      n = split(order[r], V, "\t")
      month  = trim(V[acol["Month"]])
      key    = trim(V[acol[KEY]])
      status = trim(V[acol["Change_Status"]])

      if (!(status in allowed)) { fail(month "/" key ": status '\''" status "'\'' is not one of the allowed statuses"); continue }
      if (!(month in have))     { fail(month "/" key ": labelled with a month that is not in the workbook"); continue }

      j = idx[month]; prev = (j > 1) ? C[j-1] : ""
      hasprev = (prev != "" && (prev in have))

      if (status == "Added") {
        if (!((month, key) in present)) fail(month "/" key ": Added, but the key is not in " month)
        if (hasprev && ((prev, key) in present)) fail(month "/" key ": Added, but the key was already in " prev)
      }
      else if (status == "Modified") {
        if (!((month, key) in present) || !hasprev || !((prev, key) in present))
          fail(month "/" key ": Modified, but the key is not in both months")
      }
      else if (status == "Removed") {
        if ((month, key) in present) fail(month "/" key ": Removed, but the key is still in " month)
        if (!hasprev || !((prev, key) in present)) {
          fail(month "/" key ": Removed, but the key was not in the preceding month either")
          continue
        }
        # THE RULE: a Removed row-s values must equal the PREVIOUS month-s row for that key.
        for (c = 1; c <= nh; c++) {
          col = AH[c]
          if (col == "Month" || col == "Change_Status" || col == KEY) continue
          wantv = ((prev, key, col) in sval) ? sval[prev, key, col] : ""
          gotv  = (c <= n) ? trim(V[c]) : ""
          if (wantv != gotv)
            fail(month "/" key ": Removed row carries " col "='\''" gotv "'\'', but " prev " (the month it was last seen in) says '\''" wantv "'\''")
        }
      }
    }

    if (nf) {
      printf "FAIL  %s does not match %s\n", EMITTED, SRC > "/dev/stderr"
      for (i = 1; i <= nf; i++) printf "  - %s\n", failures[i] > "/dev/stderr"
      exit 1
    }
    printf "PASS  %s matches %s\n", EMITTED, SRC
  }
' /dev/null
