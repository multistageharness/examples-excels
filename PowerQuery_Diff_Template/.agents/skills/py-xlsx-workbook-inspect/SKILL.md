---
name: py-xlsx-workbook-inspect
description: Probe an .xlsx workbook and report whether it can actually be month-diffed — which layout it uses (named Excel Tables vs plain sheets), which months are present, whether the key column exists in each, and the quiet hazards that silently distort a diff: duplicate keys, null keys, ragged column sets, and gaps in the month sequence that turn a month into a base month and suppress its changes. Exits non-zero when the workbook is not diffable. Use as the pre-flight step before py-xlsx-month-diff, when a diff came back unexpectedly empty, when you are handed an unfamiliar workbook, or when a run fails with a missing-key or no-month-tables error.
license: MIT
compatibility: Python >= 3.9 with openpyxl.
metadata:
  role: preflight
dependencies:
  - py-xlsx-diff-commons
---

# py-xlsx-workbook-inspect

Look at the workbook before you diff it. The diff's failure modes are quiet — it does not crash
on a workbook it cannot make sense of, it just returns fewer rows than you expected, and the
rows it drops are exactly the ones you were looking for.

```bash
python3 scripts/inspect_workbook.py WORKBOOK.xlsx [-k ID] [--table-prefix tbl_] [--json]
```

Exit **0** = diffable as configured. Exit **1** = not diffable; the reason is printed. Warnings
are legal-but-surprising findings and do **not** fail the run.

## What it reports

```
workbook : book.xlsx
layout   : named-tables
key      : ID
months   : Jan, Mar
columns  : ID, Status, Owner

Month    Rows  Key?  Source             Columns
------- -----  ----- ------------------ ------------------------------
Jan         4  yes   table tbl_Jan      ID, Status, Owner
Mar         4  yes   table tbl_Mar      ID, Status, Owner

warn  Mar: predecessor Feb is absent, so Mar is treated as a base month and contributes no changes.

OK: diffable (2 month(s) found).
```

That warning is the single most valuable line this skill prints — see below. Pass `--json` for a
machine-readable report to gate a pipeline on.

## The hazards it catches

**Gap in the month sequence → silently empty diff.** A month whose *immediate* predecessor is
missing is treated as a base month; the comparison short-circuits rather than reaching back for
the nearest available month. A workbook with Jan and Mar but no Feb therefore produces **zero
changes** — Jan is the base month, and Mar's predecessor is absent so Mar is one too. Nothing
errors. You just get an empty file and no explanation. (This is faithful to `List.Generate` in
the M template, which carries `Prev` forward as null.)

**Duplicate keys → a row vanishes.** Two rows with the same key in one month: the **last** one
wins, matching a join's last-write semantics. The other is simply not in the diff.

**Null keys → the row is not joinable.** A row with a blank key is excluded from the index, and
therefore from the diff entirely.

**Ragged columns → blanks, not errors.** When months disagree about their columns, the output
carries the *union* in first-seen order and missing cells come out blank. A column that exists in
only one month still appears.

**Wrong layout → "no month tables".** Named tables (`tbl_Jan`…) are tried first; plain sheets
(`Jan`…) are the fallback, used **only** when no named table matched at all. The two are never
mixed. If your tables use a different prefix, say so with `--table-prefix`.

**Missing key column → hard error.** Every month that was found must contain the key (default
`ID`). A diff has no meaning without a join key, so this exits 1 and names the offending months.
Fix it with `-k`.

## Reading the output

| Field | Means |
| --- | --- |
| `layout` | `named-tables`, `sheets`, or `none`. `none` is fatal. |
| `months` | The months actually found, in calendar order. Fewer than two ⇒ nothing to compare. |
| `Key?` | Whether that month has the key column. Any `NO` is fatal. |
| `Source` | Which table or sheet each month was read from — the fastest way to spot a typo'd table name. |
| `columns` | The union across months. A column here that you did not expect means the months disagree. |

## Next step

Once it exits 0, diff it: `py-xlsx-month-diff` (or `py-xlsx-diff-commons` for the engine directly).
Afterwards, prove the output is right with `py-xlsx-diff-verify`.
