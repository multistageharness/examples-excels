---
name: bash-xlsx-diff-verify
description: Prove that an emitted diff file (.xlsx/.csv/.tsv) actually describes the workbook it came from, using shell only. Runs two independent checks — a PARITY pass that re-runs the engine and compares row for row (catching a stale, truncated, hand-edited, or wrong-workbook file) and an INVARIANT pass that re-derives each row's claim from the source workbook's raw month tables without the engine (catching an engine bug, most importantly a Removed row carrying the wrong month's values). Exits non-zero on any mismatch. Use before shipping a changes file, in CI on a box with no Python, or when a diff looks plausible but you do not trust it.
license: MIT
compatibility: POSIX shell + unzip, sed, awk. No Python, no Excel.
metadata:
  role: verification
dependencies:
  - bash-xlsx-diff-commons
---

# bash-xlsx-diff-verify

A diff file that is wrong still looks right. Every row has a plausible month, a plausible status,
and plausible values — which is exactly what makes a bad one dangerous.

```bash
./scripts/verify.sh SOURCE.xlsx CHANGES.xlsx [-k ID] [--detect-modified] [--all]
```

`CHANGES` may be `.xlsx`, `.csv`, or `.tsv` — the format is taken from the extension and read
back accordingly (the CSV reader unpicks RFC-4180 quoting). Exit **0** = every check passed.
Exit **1** = at least one failed, and each failure is printed with the row it is about.

Pass the same `--detect-modified` / `--all` / `-k` flags the diff was produced with — the
verifier has to know what the file was *supposed* to contain.

## Two checks, and the difference is the point

**PARITY** — re-run the engine over `SOURCE` and compare to `CHANGES` row for row, header
included. Catches a stale file, a truncated one, a hand-edited one, or one produced from a
different workbook entirely.

It does **not** catch an engine bug. It compares the engine against itself: if the engine is
wrong, both sides are wrong the same way and parity passes happily. That is the trap, and it is
why there is a second check.

**INVARIANT** — go back to `SOURCE`'s raw month tables and re-derive, without the diff engine,
what each emitted row is required to say. Every status makes a falsifiable claim about the
source, so check the claim rather than the row:

| Status | The claim, checked against the source |
| --- | --- |
| `Added` | The key **is** in this month and **was not** in the preceding one. |
| `Removed` | The key **is not** in this month, **was** in the preceding one — and the row's values **equal that preceding month's row**. |
| `Modified` | The key is in **both** months. |
| any | The status is in the allowed vocabulary, and the month exists in the workbook. |

## The bug this exists to catch

**A `Removed` row is labelled with the month the removal was observed in, but must carry the
values from the month *before* it** — the last month the row actually existed. The current month
has nothing to show for a row that is gone from it.

Get it backwards and you emit a row that is entirely plausible and entirely wrong. Bob (`102`) is
`Active` in January, `Inactive` in February, gone in March. The correct row is:

```
Mar  102  Removed  Inactive  Bob        <- March's row, February's values
```

Flip it to carry January's values and you get `Mar 102 Removed Active Bob` — which looks fine, and
which the invariant pass refuses:

```
FAIL  bad.csv does not match sample.xlsx
  - row missing from the output: Mar	102	Removed	Inactive	Bob
  - row in the output that the diff does not produce: Mar	102	Removed	Active	Bob
  - Mar/102: Removed row carries Status='Active', but Feb (the month it was last seen in) says 'Inactive'
```

That third line is the invariant pass, and it is the one that names the actual rule. This is the
exact failure the `with_name` variant of the template was written to prevent.

## Cross-checking the two suites

This verifier and the Python one (`py-xlsx-diff-verify`) share no code, so each is a genuine
independent check on the other's output. Both directions pass, on all five fixtures:

```bash
# a bash-built workbook, checked by Python
python3 ../py-xlsx-diff-verify/scripts/verify_diff.py source.xlsx bash_changes.xlsx

# a Python-built workbook, checked by bash
./scripts/verify.sh source.xlsx py_changes.xlsx
```

If you have both runtimes available, running both is the strongest check there is.

## What it does not check

Styling. Fill colours, column widths, the frozen header, and the `tbl_Changes` registration are
`bash-xlsx-diff-export`'s contract; this verifies **data**, not presentation. A file can pass and
still be ugly.

## Related skills

`bash-xlsx-diff-commons` (the engine being checked) · `bash-xlsx-month-diff` (produces the file) ·
`bash-xlsx-workbook-inspect` (catches bad *input* the way this catches bad output)
