# xldiff (Node / TypeScript)

A Node/TypeScript port of the `CompareMonths_changes_only_with_name` Power Query template,
and a line-for-line sibling of the Python `py_xldiff_compare_months_changes` package. Point it
at an Excel workbook that holds one table per month and it prints **only the rows that changed** —
added and removed — carrying every column along with them.

No Excel, no Power Query, no `customXml` surgery: it cracks the `.xlsx` open itself (a zip of XML)
and does the diff in pure TypeScript, so it runs in CI, in a cron job, or on a machine that has
never seen Office.

```console
$ npx tsx src/cli.ts examples/sample.xlsx
Month  ID   Change_Status  Status    Owner
-----  ---  -------------  --------  -------
Feb    103  Removed        Active    Charlie
Feb    105  Added          Active    Eve
Mar    102  Removed        Inactive  Bob
Mar    106  Added          New       Frank
```

Its output is byte-for-byte identical to the Python port's across the `table`, `csv`, and `json`
formats.

## Quick start

```bash
make install                          # npm install
make run                              # diff the generated example workbook
make run FILE=book.xlsx               # diff your own workbook
make run FILE=book.xlsx ARGS="-o out/changes.xlsx"
make test                             # run the vitest suite
```

| Target | What it does |
| --- | --- |
| `install` | `npm install` |
| `build` | Compile TypeScript to `dist/` |
| `test` | Run the vitest suite |
| `run` | Diff a workbook (`FILE=`, default: the example) |
| `sample` | Regenerate `examples/sample.xlsx` |
| `clean` | Remove `node_modules`, build artifacts, and generated files |

## Why a hand-rolled reader

The obvious choice, `exceljs`, **crashes** when it reads Excel tables authored by other tools
(openpyxl, some Excel versions) — it throws before you ever see a cell. Since reading real-world
workbooks is the whole point, the reader (`src/xlsx.ts`) parses the `.xlsx` zip and its XML parts
directly with `fflate` + `fast-xml-parser`: sheets, typed cell values (cached formula results,
date-serial decoding via the style table), and named tables. `exceljs` is used only for *writing*
the styled `.xlsx` output, where it is reliable.

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

```ts
import { readWorkbook, diffTables } from "./src/index.js";

const tables = readWorkbook("book.xlsx", { key: "ID" });
const result = diffTables(tables, "ID");

for (const change of result.changes) {
  console.log(change.month, change.key, change.status, change.values);
}
```

## Layout

```
src/
  xlsx.ts     the self-contained .xlsx reader (zip + XML -> sheets, cells, tables)
  reader.ts   load the per-month tables (named tables, then sheet fallback)
  diff.ts     the engine: compare each month to the one before it
  writer.ts   render as a console table, CSV, JSON, or a styled .xlsx (exceljs)
  cli.ts      argument parsing and exit codes
  index.ts    public API
scripts/make-sample.ts   generates examples/sample.xlsx
tests/                   41 tests: reader, diff engine, and CLI end-to-end
```
