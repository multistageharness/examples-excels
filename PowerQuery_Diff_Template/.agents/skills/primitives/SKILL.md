---
name: primitives
description: The primitive catalog for the xlsx month-over-month diff engine — every data type, pure function, and constant that makes up the read → diff → write pipeline, each with its signature, what it guarantees, and the knowledge behind it (why it exists, what it gets right that a naive version gets wrong). Covers the reader (load per-month tables, two layouts, cell/row normalization), the diff engine (full-outer-join statuses, Removed-carries-previous-month, base-month and gap handling, the mixed-type sort), the writer (four output formats, styling, format inference, the Excel-Table-needs-a-row rule), and the CLI assembly. Read this to understand or modify the engine at the level of its building blocks, to port it to another language faithfully, or to know which primitive owns a given rule before changing behavior. This is the map of the parts; py-xlsx-diff-commons/reference/CONTRACT.md is the rulebook and REQ.md is the requirement spec.
license: MIT
compatibility: Reference/knowledge skill — prose only, no scripts. Describes the Python engine (Python >= 3.9 + openpyxl) and the single-file port in py-xlsx-diff-commons/scripts/xldiff_core.py.
metadata:
  role: reference
  consumer-pattern: knowledge
dependencies:
  - py-xlsx-diff-commons
---

# primitives

The building blocks of the month-over-month diff, one entry per primitive. Every rule of the
diff lives in exactly one of these parts; this file is the index of the parts and the knowledge
that goes with each. The behavior is specified rule-by-rule in
[`py-xlsx-diff-commons/reference/CONTRACT.md`](../py-xlsx-diff-commons/reference/CONTRACT.md),
which cites `REQ.md` in the reference project
(`v1/automated/py_xldiff_compare_months_changes/`). The canonical implementation is the three
modules `src/xldiff/{reader,diff,writer}.py`, collapsed into the single runnable file
[`py-xlsx-diff-commons/scripts/xldiff_core.py`](../py-xlsx-diff-commons/scripts/xldiff_core.py).

## The pipeline

Three stages, no coupling between them. The reader knows nothing of statuses; the diff engine
knows nothing of output formats. A new input layout or a new output format lands in exactly one
module.

```
read_workbook ──► {month: MonthTable} ──► diff_tables ──► DiffResult ──► render / write_xlsx
  reader.py                                  diff.py                        writer.py
```

The public API (`src/xldiff/__init__.py`) exports the primitives a caller composes:
`read_workbook`, `diff_tables`, `compare_months`, the `MonthTable` / `ChangeRow` / `DiffResult`
types, the status constants, `MONTHS`, and `WorkbookError`.

---

## reader.py — load the per-month tables

Turns an `.xlsx` file into `{month: MonthTable}`. Two layouts, tried in order; never mixed.

### Data primitives

| Primitive | Kind | What it is |
| --- | --- | --- |
| `MonthTable` | dataclass | One month: `month`, `columns: list[str]`, `rows: list[dict]`, `source: str`. |
| `MonthTable.by_key(key)` | method | Index rows by key value → `{key: row}`. **Last duplicate wins**; **null keys excluded**. This is the join index the diff consumes. |
| `WorkbookError` | exception | The single error type for every "can't diff this" condition, so the CLI reports them uniformly. |
| `MONTHS` | constant | `["Jan"…"Dec"]` in calendar order — the default month set and their order. |
| `DEFAULT_TABLE_PREFIX` | constant | `"tbl_"`. |
| `DEFAULT_KEY` | constant | `"ID"`. |

### Function primitives

| Primitive | Signature | What it guarantees |
| --- | --- | --- |
| `_clean` | `(value) -> value` | Cell normalizer. `str` → stripped, and whitespace-only → `None`. Non-strings pass through **with their Excel type intact** (int, float, bool, datetime). |
| `_rows_from_grid` | `(grid) -> (columns, rows)` | The shape engine. First row = header. Drops trailing unnamed columns (Excel padding); names a non-trailing blank header `Column<N>` (1-based); skips all-empty spacer rows; right-pads short rows and truncates long rows to header width. |
| `_read_named_tables` | `(wb, prefix, months) -> {month: MonthTable}` | Layout #1: real Excel Tables (ListObjects) named `tbl_Jan…tbl_Dec`, matched **case-insensitively**. Reads each table's declared `ref` range. |
| `_read_sheets` | `(wb, months) -> {month: MonthTable}` | Layout #2 (fallback): worksheets titled `Jan…Dec`, matched case-insensitively after trimming whitespace, header in row 1. |
| `read_workbook` | `(path, key="ID", table_prefix="tbl_", months=None) -> {month: MonthTable}` | The public entry point. Opens `data_only=True`, tries named tables then sheets, validates, returns months in configured order. |

### Knowledge

- **Two layouts, preference order, never mixed.** Named tables are tried first; the sheet fallback
  is used **only** when *no* named table matched at all (`read_workbook`). Excel's Power Query can
  read *only* named tables — `Excel.CurrentWorkbook()` never sees a bare sheet — so the sheet path
  is the thing this port adds over the original M template.
- **`data_only=True` reads cached values, not formulas.** A cell holding `=A1+1` yields its last
  saved result. A workbook never opened in Excel has no cached values; that is a workbook problem,
  not an engine one.
- **The reader validates, then stops.** Three failures, all `WorkbookError`: the file does not
  exist; nothing opened as `.xlsx`; no month found under either layout. Plus one that matters for
  the join: **every month that *was* found must contain the key column** — a diff has no meaning
  without a join key, so a found-but-keyless month is an error listing the offenders in month order.
- **A month with no columns is treated as absent, not empty** (`_rows_from_grid` returns `[], []`
  and the caller skips it). Absent months are never an error — the diff engine handles the gap.
- **The workbook handle is always closed**, including when reading raises (the `finally`).

---

## diff.py — compare each month to the one before it

A direct port of the M in `CompareMonths_changes_only_with_name.query`. Walks the months in order
and emits the changed rows.

### Data primitives

| Primitive | Kind | What it is |
| --- | --- | --- |
| `ChangeRow` | dataclass | One output row: `month`, `key`, `status`, `values: dict`. `as_dict(key_col, columns)` flattens to `Month, <key>, Change_Status, …rest`. |
| `DiffResult` | dataclass | The whole diff: `key_column`, `columns`, `changes`. `.header`, `.as_dicts()`, `len()`. Ready to hand to the writer. |
| `ADDED` `REMOVED` `UNCHANGED` `MODIFIED` `BASE_MONTH` | constants | The status vocabulary. |
| `CHANGE_STATUSES` | constant | `(ADDED, REMOVED, MODIFIED)` — the statuses that count as an actual change and survive the default filter. |
| `MONTH_COLUMN` / `STATUS_COLUMN` | constants | `"Month"` / `"Change_Status"`. |

### Function primitives

| Primitive | Signature | What it guarantees |
| --- | --- | --- |
| `_sort_key` | `(value) -> (rank, num, text)` | Human reading order over a mixed-type column (see Knowledge). |
| `_values_differ` | `(prev, curr, columns, key) -> bool` | True if any **non-key** column of the *current* month differs. Powers `Modified`. |
| `compare_months` | `(previous, current, key="ID", detect_modified=False) -> list[ChangeRow]` | **The core engine.** `previous=None` → every row `Base Month`. Else: full-outer-join semantics — current-only key = `Added`, previous-only key = `Removed`, key-in-both = `Unchanged` (or `Modified`). Sorted by key. |
| `diff_tables` | `(tables, key="ID", months=None, include_unchanged=False, detect_modified=False) -> DiffResult` | **The orchestrator.** Walks months in order, compares each to the configured predecessor, accumulates the column union, filters to change-statuses unless `include_unchanged`. |

### Knowledge — the three rules a wrong-but-plausible diff gets backwards

1. **A `Removed` row carries the *previous* month's values.** A removed key exists only in the
   previous month, so that is where its data comes from (`compare_months`, the second loop). The
   row is *labeled* with the current month — the month the removal was **observed** — but its
   values are from the month it was **last seen** in. `Mar / 102 / Removed / Inactive / Bob` means
   Bob vanished in March and `Inactive` is what he was in February. Get this backwards and the file
   still looks completely fine — which is exactly why the source template is named `with_name` and
   why `py-xlsx-diff-verify` re-derives every row from the source instead of trusting the engine.

2. **A gap in the months yields an empty diff, not an error.** `diff_tables` compares each month to
   its *immediate predecessor in the configured month list* — `months[index-1]` — not the nearest
   available month. If that predecessor is absent, `previous` is `None` and the month becomes a
   base month; base rows are filtered out by default. Jan + Mar with no Feb → **zero changes,
   silently.** This is faithful to `List.Generate` carrying `Prev` forward as null in the M code,
   and it is the reason a workbook-inspect step exists.

3. **`Modified` is opt-in.** Without `detect_modified`, a key that survives with changed values is
   `Unchanged` and gets filtered out — M-parity with the original template, which only ever emits
   Added/Removed. `_values_differ` compares only the **current** month's non-key columns.

### Knowledge — the rest

- **The join index is last-write-wins and null-key-blind** — that lives in `MonthTable.by_key`
  (reader), not here. Duplicate keys collapse to the last row; a null key is not a joinable row and
  never reaches the diff.
- **`_sort_key` exists because Excel mixes types in one column.** Ints, floats, strings and blanks
  are not mutually comparable in Python 3, so sorting raw would crash. The explicit rank is:
  numbers first and numerically (numeric *strings* sort with them), then text case-insensitively,
  then nulls last; booleans sort with the text. Within a month, rows come out in this order.
- **Output column order and the column union.** `DiffResult.header` is `Month`, `<key>`,
  `Change_Status`, then the trailing data columns. The trailing set is the **union of every read
  month's columns, in first-seen order** across months, key excluded — so a column present in only
  one month still appears, and a row missing it emits `None` rather than failing.

---

## writer.py — render a DiffResult four ways

Text (`table`/`csv`/`json`) via `render`; binary via `write_xlsx`.

### Data primitives

| Primitive | Kind | What it is |
| --- | --- | --- |
| `FORMATS` | constant | `("table", "csv", "json", "xlsx")`. |
| `_HEADER_FILL` / `_HEADER_FONT` | constants | Orange `ED7D31` fill, bold white font — matches the Power Query output header. |
| `_STATUS_FILLS` | constant | Row fills: `Added` green `E2EFDA`, `Removed` red `FCE4E4`, `Modified` amber `FFF2CC`. |

### Function primitives

| Primitive | Signature | What it guarantees |
| --- | --- | --- |
| `format_for` | `(path, requested) -> str` | Format selection: explicit `--format` wins; else infer from extension (`.xlsx/.xlsm`→xlsx, `.json`→json, `.csv/.txt`→csv); else `table`. |
| `_scalar` | `(value) -> value` | date/time/datetime → ISO-8601 string (Excel dates are not natively JSON/CSV-safe); everything else unchanged. |
| `_text` | `(value) -> str` | `None` → `""`, else `str(_scalar(value))`. |
| `to_table` | `(result) -> str` | Fixed-width, column-aligned terminal table with a dashed rule; trailing whitespace stripped per line. |
| `to_csv` | `(result) -> str` | Standard CSV with a header row. |
| `to_json` | `(result) -> str` | Array of objects, keys in header order, indented 2. |
| `write_xlsx` | `(result, path) -> None` | Styled single sheet named `Changes` (see Knowledge). |
| `render` | `(result, fmt) -> str` | Dispatch for the three text formats; raises for `xlsx` — it is binary and cannot be a string. |

### Knowledge

- **`write_xlsx` produces a workbook that can be fed back in as input.** The output range is
  registered as an Excel Table named `tbl_Changes` (`TableStyleMedium2`, row stripes) — so the diff
  of a diff is possible. Header row styled to match Power Query, rows fill-coded by status, columns
  auto-sized to the longest value + padding (capped at 40), header frozen.
- **An Excel Table requires at least one data row.** On an empty diff, `write_xlsx` falls back to a
  plain autofilter over the header instead of a Table — so a zero-change run still writes a *valid*
  workbook rather than a corrupt one. (This asymmetry is a real footgun: it is why the text formats
  must also exit `0`, not `1`, on an empty diff.)
- **Dates are serialized once, in `_scalar`,** and every format routes through it — so the ISO-8601
  rule holds identically across table, csv, json, and the xlsx cell values.

---

## cli.py — assemble the primitives into a command

Not a diff primitive itself; the composition layer. Included so the catalog is complete.

| Primitive | Signature | What it does |
| --- | --- | --- |
| `EXIT_OK` / `EXIT_ERROR` | constants | `0` / `1`. |
| `build_parser` | `() -> ArgumentParser` | Declares the flags: `workbook`, `-o/--output`, `-f/--format`, `-k/--key`, `--table-prefix`, `--months`, `--detect-modified`, `--all`, `--version`. |
| `_parse_months` | `(raw) -> list[str]` | Validates `--months`: unknown names are an error listing the accepted set; fewer than two months is an error (nothing to compare). |
| `main` | `(argv=None) -> int` | `read_workbook` → `diff_tables` → `format_for` → `render`/`write_xlsx`. |

### Knowledge

- **Errors are messages, never tracebacks.** Every `WorkbookError` is caught and printed as
  `xldiff: <message>` to **stderr**, returning `EXIT_ERROR`.
- **stdout stays clean for data.** With `--output`, the parent directory is created, text is written
  UTF-8, and the one-line summary (row count, months found, destination) goes to **stderr** — so
  piping stdout gives you only the diff.
- **`--format xlsx` without `--output` is an error** — there is nowhere to write the binary.

---

## Where each rule lives (quick index)

| To change… | Edit this primitive |
| --- | --- |
| What counts as a blank / how types survive | `reader._clean` |
| Header, padding, spacer, ragged-row handling | `reader._rows_from_grid` |
| Which workbook layouts are accepted | `reader._read_named_tables` / `_read_sheets` |
| Join semantics: duplicates, null keys | `reader.MonthTable.by_key` |
| Added / Removed / Unchanged / Modified logic | `diff.compare_months` |
| Which month a Removed row's values come from | `diff.compare_months` (second loop) |
| Gap / base-month handling | `diff.diff_tables` |
| Row ordering within a month | `diff._sort_key` |
| Output column order and the column union | `diff.DiffResult.header` + `diff.diff_tables` |
| A new output format | `writer` (`render` + a `to_*`) |
| Status colors / header style | `writer._STATUS_FILLS` / `_HEADER_FILL` |
| Format inference from a path | `writer.format_for` |
| Flags, exit codes, stderr/stdout split | `cli` |

Change any behavior here and update `py-xlsx-diff-commons/reference/CONTRACT.md` (and the verifier)
with it — the contract is the source of truth the two implementations and the tests are judged
against.
