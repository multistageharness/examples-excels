# xldiff

A Python port of the `CompareMonths_changes_only_with_name` Power Query template. Point it at
an Excel workbook that holds one table per month and it prints **only the rows that changed** —
added and removed — carrying every column along with them.

No Excel, no Power Query, no `customXml` surgery: it reads the workbook with `openpyxl` and does
the diff in Python, so it runs in CI, in a cron job, or on a machine that has never seen Office.

```console
$ xldiff examples/sample.xlsx
Month  ID   Change_Status  Status    Owner
-----  ---  -------------  --------  -------
Feb    103  Removed        Active    Charlie
Feb    105  Added          Active    Eve
Mar    102  Removed        Inactive  Bob
Mar    106  Added          New       Frank
```

## Quick start

```bash
make install                          # create .venv and install the package
make run                              # diff the generated example workbook
make run FILE=book.xlsx               # diff your own workbook
make run FILE=book.xlsx ARGS="-o out/changes.xlsx"
make test                             # run the suite
```

| Target | What it does |
| --- | --- |
| `setup` | Create the `.venv` |
| `install` | Install the package plus dev deps, editable |
| `test` | Run the pytest suite |
| `run` | Diff a workbook (`FILE=`, default: the example) |
| `sample` | Regenerate `examples/sample.xlsx` |
| `clean` | Remove the venv, build artifacts, and generated files |

## Workbook layout

One table per month, either shape:

1. **Excel tables** (ListObjects) named `tbl_Jan` … `tbl_Dec` — what the Power Query template
   requires, since `Excel.CurrentWorkbook()` only sees named tables.
2. **Sheets** named `Jan` … `Dec`, header in row 1 — the fallback, used when the workbook
   defines no tables. This is the common case, and the Power Query version cannot read it.

Every month needs a key column (`ID` by default) that identifies a row across months. Months that
aren't in the workbook are simply skipped.

## What counts as a change

Each month is compared against **the month before it**:

| Status | Meaning |
| --- | --- |
| `Added` | The key is in this month but not the previous one |
| `Removed` | The key was in the previous month and is gone from this one |
| `Modified` | The key survived but a value changed — only with `--detect-modified` |
| `Unchanged` / `Base Month` | Filtered out unless you pass `--all` |

Removed rows are reported **against the month they disappeared in**, and their values come from the
month they were *last seen* in — the current month has nothing to show for them. That is the whole
point of the `with_name` variant: `Mar / 102 / Removed` above still tells you Bob was `Inactive`,
because that is what he was in February, the last month he existed.

The first month present is the base month — there is nothing before it to compare against. A month
whose predecessor is missing from the workbook is treated the same way, matching how `List.Generate`
carries a null `Prev` forward in the M code.

## CLI

```
xldiff WORKBOOK [-o OUTPUT] [-f {table,csv,json,xlsx}] [-k COLUMN]
                [--table-prefix PREFIX] [--months LIST]
                [--detect-modified] [--all]
```

| Flag | Effect |
| --- | --- |
| `-o, --output` | Write to a file instead of stdout; creates parent directories |
| `-f, --format` | `table` (default), `csv`, `json`, or `xlsx`; inferred from `-o`'s extension |
| `-k, --key` | The column identifying a row across months (default: `ID`) |
| `--table-prefix` | Prefix of the per-month table names (default: `tbl_`) |
| `--months` | Comma-separated months, in order, to compare (default: `Jan`…`Dec`) |
| `--detect-modified` | Also report rows whose key stayed but whose values changed |
| `--all` | Include `Unchanged` and `Base Month` rows too |

`xlsx` output is a styled, filterable sheet: added rows green, removed red, modified amber.
Exit code is `0` on success and `1` on a bad workbook, a missing key column, or an unknown month.

## Library

```python
from xldiff import diff_tables, read_workbook

tables = read_workbook("book.xlsx", key="ID")
result = diff_tables(tables, key="ID")

for change in result.changes:
    print(change.month, change.key, change.status, change.values)
```

## Layout

```
src/xldiff/
  reader.py   load the per-month tables (named tables, then sheet fallback)
  diff.py     the engine: compare each month to the one before it
  writer.py   render as a console table, CSV, JSON, or a styled .xlsx
  cli.py      argument parsing and exit codes
scripts/make_sample.py   generates examples/sample.xlsx
tests/                   41 tests: reader, diff engine, and CLI end-to-end
```
