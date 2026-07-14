---
name: py-xlsx-diff-export
description: Write a month-over-month diff to a NEW file in the right shape — a styled .xlsx (status-colour-coded, frozen header, registered as an Excel Table so the output can be fed back in as input), or .csv / .json / a fixed-width console table. Covers format inference from the output extension, the column order contract (Month, key, Change_Status, then the union of data columns), ISO-8601 date handling, and the empty-diff case that would otherwise emit an invalid workbook. Use when choosing an output format, when the emitted file looks wrong (missing columns, unstyled, broken table), when piping the diff into another tool, or when the changes file must itself be re-readable as a month workbook.
license: MIT
compatibility: Python >= 3.9 with openpyxl.
metadata:
  role: output
dependencies:
  - py-xlsx-diff-commons
---

# py-xlsx-diff-export

The output half of the diff. The engine hands you a `DiffResult`; this is how it becomes a file
someone can open.

## Picking a format

Four formats: `table`, `csv`, `json`, `xlsx`. You rarely need to name one — it is inferred from
the output extension, and an explicit `-f` wins over the inference.

```bash
CORE=../py-xlsx-diff-commons/scripts/xldiff_core.py

python3 "$CORE" book.xlsx -o changes.xlsx    # styled workbook   (.xlsx / .xlsm)
python3 "$CORE" book.xlsx -o changes.csv     # csv               (.csv / .txt)
python3 "$CORE" book.xlsx -o changes.json    # json              (.json)
python3 "$CORE" book.xlsx                    # fixed-width table (stdout, the default)
```

| Format | For | Notes |
| --- | --- | --- |
| `xlsx` | Handing to a human | Colour-coded, filterable, re-readable as input. Needs `-o` — it is binary and cannot go to stdout. |
| `csv` | Piping into another tool | Header row, standard quoting. |
| `json` | Feeding a program | Array of objects, keys in header order, indent 2. |
| `table` | Looking at it now | Column-aligned, dashed rule, trailing whitespace stripped. |

With `-o`, the data goes to the file and a one-line summary goes to **stderr** — so stdout stays
clean and pipeable. Parent directories are created for you.

## The column contract

Every format emits the same shape:

```
Month | <key> | Change_Status | ...every remaining data column
```

The trailing columns are the **union** of all months' columns, in first-seen order across the
months. A column that exists in only one month still appears, and rows that lack it emit blank
rather than failing. Rows are grouped by month in month order, and within a month sorted by key —
numbers first and numerically, then text case-insensitively, then nulls last.

Dates, times, and datetimes serialize as **ISO-8601** in every text format, because Excel hands
them back as `datetime` objects and those are neither JSON- nor CSV-safe. `None` renders as an
empty string.

## The .xlsx writer

The only format that carries meaning beyond the values:

- One sheet, named **`Changes`**.
- Header: **bold white on orange** (`ED7D31`), left-aligned, and **frozen**.
- Rows **fill-coded by status** — `Added` green (`E2EFDA`), `Removed` red (`FCE4E4`), `Modified`
  amber (`FFF2CC`). Any other status is left unfilled.
- Columns auto-sized to the longest value, capped at 40 characters.
- The range is registered as a real Excel Table named **`tbl_Changes`**, styled
  `TableStyleMedium2` with row stripes.

That last point is the useful one: because the output is a *named table*, the changes file
satisfies the suite's own input contract. You can diff a diff, or feed it to Power Query — which
only ever sees named tables.

**The empty case.** An Excel Table requires at least one data row. When the diff is empty, the
writer falls back to an autofilter over the header instead, so a zero-change run still produces a
workbook that opens. (A zero-change run is not necessarily a bug — a gap in the month sequence
produces one legitimately. Check with `py-xlsx-workbook-inspect`.)

## Using it from Python

Rendering and diffing are decoupled — the writer knows nothing about statuses, the engine nothing
about formats — so a new format can be added without touching the diff:

```python
from xldiff_core import read_workbook, diff_tables, render, write_xlsx

result = diff_tables(read_workbook("book.xlsx", key="ID"), key="ID")

write_xlsx(result, "changes.xlsx")     # binary: its own function
text = render(result, "json")          # text formats: table / csv / json
```

`render(result, "xlsx")` deliberately raises — a binary format cannot be rendered to a string,
and asking for it through the text path is a programming error, not a runtime one.

## Verify what you wrote

An emitted file that *looks* right can still be wrong — most memorably when a `Removed` row
carries the wrong month's values. Before you hand the file over:

```bash
python3 ../py-xlsx-diff-verify/scripts/verify_diff.py book.xlsx changes.xlsx
```

## Related skills

`py-xlsx-diff-commons` (the engine, the full flag table) · `py-xlsx-month-diff` (the end-to-end flow) ·
`py-xlsx-diff-verify` (prove it is right)
