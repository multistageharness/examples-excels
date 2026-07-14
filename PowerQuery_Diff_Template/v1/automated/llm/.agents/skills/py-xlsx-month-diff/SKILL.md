---
name: py-xlsx-month-diff
description: Take an Excel workbook holding one table per month (tbl_Jan..tbl_Dec, or sheets named Jan..Dec) and extract only the rows that changed month over month — added, removed, and optionally modified — into a NEW file (.xlsx, .csv, or .json), without needing Excel, Office, or Power Query. This is the end-to-end entry point of the suite: inspect the workbook, run the diff, write the new file, verify it. Use when asked to diff/compare months in a spreadsheet, find what changed between months, extract changes to a new workbook, produce a change log from an Excel file, or port the CompareMonths Power Query template to something that runs in CI.
license: MIT
compatibility: Python >= 3.9 with openpyxl. No Excel, Office, or Power Query required.
metadata:
  role: entry-point
dependencies:
  - py-xlsx-diff-commons
---

# py-xlsx-month-diff

Workbook in, changes file out. One table per month; each month compared to the one before it;
only the rows that changed survive.

```
sample.xlsx  ──►  inspect  ──►  diff  ──►  changes.xlsx
 tbl_Jan          layout?       Added        Month ID Change_Status Status Owner
 tbl_Feb          key?          Removed      Feb   103 Removed      Active Charlie
 tbl_Mar          gaps?         Modified     Mar   102 Removed      Inactive Bob
```

It reads the workbook directly, so it runs in CI, in a cron job, or on a machine that has never
had Office installed (REQ-1.4). It never compares two separate workbooks — the months live inside
one file (REQ-1.1).

## The workflow

Paths below are relative to this skill's directory. `$WB` is the workbook to diff.

### 1. Inspect before you diff

Never diff a workbook you have not looked at. The failure modes are quiet: a missing month
silently suppresses changes, a duplicate key silently drops a row.

```bash
python3 ../py-xlsx-workbook-inspect/scripts/inspect_workbook.py "$WB"
```

Exit 0 means diffable. Read the warnings — especially a gap in the month sequence, which is the
one that produces a confusingly empty result. See `py-xlsx-workbook-inspect`.

### 2. Diff it into a new file

```bash
CORE=../py-xlsx-diff-commons/scripts/xldiff_core.py

python3 "$CORE" "$WB" -o changes.xlsx      # styled workbook, colour-coded by status
python3 "$CORE" "$WB" -o changes.csv       # or .json
python3 "$CORE" "$WB"                      # or just print it
```

The format is inferred from the output extension; `-f` overrides it. Add `--detect-modified` to
also catch rows whose key stayed but whose values changed, and `--all` to keep `Unchanged` and
`Base Month` rows. Full flag table: `py-xlsx-diff-commons`.

### 3. Verify the file you just wrote

```bash
python3 ../py-xlsx-diff-verify/scripts/verify_diff.py "$WB" changes.xlsx
```

Exit 0 = the emitted file genuinely describes that workbook. This is cheap and it catches both a
stale/wrong-workbook output and the classic `Removed`-row bug. Do it before handing the file to
anyone. See `py-xlsx-diff-verify`.

## What you get

Columns are `Month`, the key, `Change_Status`, then the union of every month's data columns. Rows
are grouped by month, sorted by key. Running the suite's `sample.xlsx` fixture:

```
Month  ID   Change_Status  Status    Owner
-----  ---  -------------  --------  -------
Feb    103  Removed        Active    Charlie
Feb    105  Added          Active    Eve
Mar    102  Removed        Inactive  Bob
Mar    106  Added          New       Frank
```

In `.xlsx` the rows are fill-coded — `Added` green, `Removed` red, `Modified` amber — and the
output range is registered as an Excel Table (`tbl_Changes`), so **the changes file can itself be
fed back in as an input workbook**.

## Three things that will surprise you

**A `Removed` row carries the *previous* month's values.** `Mar / 102 / Removed / Inactive / Bob`
means Bob disappeared in March, and `Inactive` is what he was in February — the last month he
existed. The row is labeled with the month the removal was *observed*, but the data comes from
the month it was last *seen*. March has nothing to show for a row that is gone from it. This is
the whole reason the `with_name` variant of the template exists.

**A gap in the months yields no changes, not an error.** A month whose immediate predecessor is
absent is treated as a base month; the comparison short-circuits rather than reaching further
back. A workbook with Jan and Mar but no Feb produces an **empty** diff — Jan is the base month,
and Mar's predecessor is missing so Mar is a base month too. That is faithful to the M template's
`List.Generate`, and it is why step 1 exists.

**Modified is opt-in.** By default a row whose key survived but whose *values* changed is
`Unchanged` and is filtered out. That is M-parity with the original template. If you want value
changes, pass `--detect-modified`.

## When this is the wrong skill

- The workbook's months must stay live and refreshable **inside Excel** → use
  `py-powerquery-m-diff-inject` to rewrite the embedded M query instead. That path keeps Power Query
  in the loop; this one replaces it.
- You are comparing **two separate workbooks** → this suite does not do that. It compares the
  months *within* one file.

## Related skills

`py-xlsx-diff-commons` (the engine and the contract) · `py-xlsx-workbook-inspect` (step 1) ·
`py-xlsx-diff-export` (formats and styling) · `py-xlsx-diff-verify` (step 3) ·
`py-powerquery-m-diff-inject` (the Excel-native alternative)
