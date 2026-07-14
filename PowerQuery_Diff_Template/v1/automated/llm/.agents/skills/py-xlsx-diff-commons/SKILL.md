---
name: py-xlsx-diff-commons
description: Shared engine, contract, and fixtures for the xlsx month-over-month diff suite. Owns xldiff_core.py — the single canonical read/diff/write implementation that every other skill in the suite calls instead of re-implementing the rules — plus reference/CONTRACT.md (the status vocabulary, the Removed-row values rule, gap handling, output shape) and make_fixtures.py (generated, never-committed test workbooks). Load this when you need to know how the diff is DEFINED, when another skill needs the engine, or when you are regenerating fixtures. Other skills depend on this one; start here before changing any diff behavior.
license: MIT
compatibility: Python >= 3.9 with openpyxl installed. No Excel, Office, or Power Query required.
metadata:
  role: commons
  consumer-pattern: dependency
---

# py-xlsx-diff-commons

The one place the diff is defined. Every other skill in this suite shells out to or imports
`scripts/xldiff_core.py`; none of them re-implement the rules, so there is exactly one thing to
change when the contract changes.

## What is here

| Path | What it is |
| --- | --- |
| `scripts/xldiff_core.py` | The engine: reader + diff + writer + CLI, in one dependency-light file. Importable *and* runnable. |
| `scripts/make_fixtures.py` | Generates the four test workbooks the suite is exercised against. |
| `reference/CONTRACT.md` | The rules, each citing the `REQ.md` requirement it implements. **Read this before changing behavior.** |

## Setup

The engine needs `openpyxl` and nothing else — deliberately, so it runs in CI or a cron job on a
machine that has never seen Office (REQ-1.4).

```bash
pip install openpyxl
```

The reference project (a sibling of the `llm/` tree) already ships a virtualenv with it; any
interpreter that can `import openpyxl` works.

## Using the engine

As a CLI:

```bash
python3 scripts/xldiff_core.py WORKBOOK.xlsx                    # print the changes
python3 scripts/xldiff_core.py WORKBOOK.xlsx -o changes.xlsx    # write a new styled workbook
python3 scripts/xldiff_core.py WORKBOOK.xlsx -f json            # or csv / table
```

As a library — the three stages are decoupled, so a new input layout or output format can be
added without touching the other two (REQ-6.2):

```python
from xldiff_core import read_workbook, diff_tables, write_xlsx

tables = read_workbook("book.xlsx", key="ID")   # {month: MonthTable}
result = diff_tables(tables, key="ID")          # DiffResult
write_xlsx(result, "changes.xlsx")
```

| Option | Effect | Default |
| --- | --- | --- |
| `-o, --output PATH` | Write to a file (parent dirs created) | stdout |
| `-f, --format FMT` | `table` \| `csv` \| `json` \| `xlsx` | inferred from `-o`, else `table` |
| `-k, --key COLUMN` | The column identifying a row across months | `ID` |
| `--table-prefix PREFIX` | Prefix of the per-month table names | `tbl_` |
| `--months LIST` | Comma-separated months, in order | `Jan..Dec` |
| `--detect-modified` | Also report same-key/changed-value rows as `Modified` | off |
| `--all` | Include `Unchanged` and `Base Month` rows | off |

## The contract, in one paragraph

Each month is compared to **the month immediately before it**. A key only in the current month is
`Added`; a key only in the previous month is `Removed`; a key in both is `Unchanged` (or
`Modified` with `--detect-modified`). The first month present is the `Base Month`. Only `Added` /
`Removed` / `Modified` are emitted unless you pass `--all`.

The rule that is easy to get backwards, and the reason this suite exists: **a `Removed` row is
labeled with the month the removal was observed in, but carries the values from the month before
it** — the last month the row actually existed. The current month has nothing to show for a row
that is gone from it. Get this wrong and you still get a plausible-looking file, which is why
`py-xlsx-diff-verify` re-checks it against the source rather than trusting the engine.

Full rules, with requirement citations: `reference/CONTRACT.md`.

## Fixtures

```bash
python3 scripts/make_fixtures.py [OUTDIR]     # default: ./fixtures
```

Generated, not committed — so they are regenerated on demand and reviewed as code, not as binary
blobs.

| Fixture | Exercises |
| --- | --- |
| `sample.xlsx` | The canonical 3-month workbook as real Excel Tables. Reproduces the reference output. |
| `sheets.xlsx` | The sheet-fallback layout (no named tables) — which Power Query cannot read at all. |
| `gap.xlsx` | Jan + Mar, no Feb. Mar's predecessor is missing, so Mar is a base month and the diff is **empty**. |
| `messy.xlsx` | Duplicate key, null key, spacer row, trailing unnamed column, and a column present in only one month. |

`sample.xlsx` produces exactly this, which is the suite's golden output:

```
Month  ID   Change_Status  Status    Owner
-----  ---  -------------  --------  -------
Feb    103  Removed        Active    Charlie
Feb    105  Added          Active    Eve
Mar    102  Removed        Inactive  Bob
Mar    106  Added          New       Frank
```

Note `Mar / 102 / Removed / Inactive / Bob`: Bob was `Active` in January and `Inactive` in
February before vanishing in March. The row is labeled March and carries February's values. If a
change ever makes that row read `Active`, the contract is broken.

## Related skills

- `py-xlsx-workbook-inspect` — check a workbook is diffable *before* diffing it.
- `py-xlsx-month-diff` — the end-to-end workflow: workbook in, changes file out.
- `py-xlsx-diff-export` — the output formats and the styled `.xlsx` writer.
- `py-xlsx-diff-verify` — prove an emitted file actually describes its source workbook.
- `py-powerquery-m-diff-inject` — the Excel-native path: rewrite the embedded M query instead.
