---
name: bash-xlsx-workbook-inspect
description: Probe an .xlsx workbook with shell only (unzip/sed/awk) and report whether it can be month-diffed — which layout it uses (named Excel Tables vs plain sheets), which months are present, whether the key column exists in each, and the quiet hazards that silently distort a diff: duplicate keys, null keys, ragged column sets, and gaps in the month sequence that turn a month into a base month and suppress its changes. Exits non-zero when the workbook is not diffable. Use as the pre-flight step before bash-xlsx-month-diff, when a diff came back unexpectedly empty, or on a box with no Python.
license: MIT
compatibility: POSIX shell + unzip, sed, awk. No Python, no Excel.
metadata:
  role: preflight
dependencies:
  - bash-xlsx-diff-commons
---

# bash-xlsx-workbook-inspect

Look at the workbook before you diff it. The diff's failure modes are quiet — it does not crash
on a workbook it cannot make sense of, it just returns fewer rows than you expected, and the rows
it drops are the ones you were looking for.

```bash
./scripts/inspect.sh WORKBOOK.xlsx [-k ID]
```

Exit **0** = diffable. Exit **1** = not, and the reason is printed. Warnings are legal-but-
surprising findings and do **not** fail the run.

## What it reports

```
workbook : book.xlsx
layout   : named-tables
key      : ID
months   : Jan, Mar

Month    Rows  Key?  Columns
------- -----  ----- ------------------------------
Jan         4  yes   ID, Status, Owner
Mar         4  yes   ID, Status, Owner

warn  Mar: predecessor Feb is absent, so Mar is treated as a base month and contributes no changes.

OK: diffable (2 month(s) found).
```

That warning is the most valuable line it prints.

## The hazards it catches

**Gap in the month sequence → silently empty diff.** A month whose *immediate* predecessor is
missing is treated as a base month; the comparison short-circuits rather than reaching back for
the nearest available month. Jan + Mar with no Feb therefore yields **zero changes** — Jan is the
base month, and Mar's predecessor is absent so Mar is one too. Nothing errors. You just get an
empty file and no explanation.

**Duplicate keys → a row vanishes.** Two rows with the same key in one month: the **last** wins,
matching a join's last-write semantics. The other is not in the diff.

**Null keys → not joinable.** A row with a blank key is excluded from the index, and so from the
diff entirely.

**Ragged columns → blanks, not errors.** When months disagree about their columns, the output
carries the *union* and missing cells come out blank.

**Wrong layout → "no month tables".** `layout` tells you which of the two the reader actually
resolved:

| `layout` | Means |
| --- | --- |
| `named-tables` | Found `tbl_Jan`… — the canonical layout. The table carries its own range, so it may sit on a sheet named anything. |
| `sheets` | No table matched any month, so it fell back to sheets titled `Jan`…`Dec`, header in row 1. |
| `none` | Neither. Fatal — and the sheet names present are printed so you can see why. |

The two layouts are never mixed. If your tables use a different prefix, the engine takes
`--table-prefix`.

**Missing key column → hard error.** Every month found must contain the key (default `ID`). A
diff has no meaning without a join key, so this exits 1 and names the offending months. Fix with
`-k`.

## Next step

Once it exits 0, diff it with `bash-xlsx-month-diff`, then prove the output with
`bash-xlsx-diff-verify`.

## Related skills

`bash-xlsx-diff-commons` (the reader this drives) · `bash-xlsx-month-diff` (the diff) ·
`py-xlsx-workbook-inspect` (the Python twin, which also decodes dates)
