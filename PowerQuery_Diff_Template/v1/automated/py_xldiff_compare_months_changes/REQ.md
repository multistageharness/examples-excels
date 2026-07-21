# xldiff — Requirements

Requirements reverse-engineered from the implementation (`src/py_xldiff_compare_months_changes/`). Each requirement
states the behavior the code guarantees today and cites the source that implements it, so the
document can be used both as a specification for a re-implementation (in another language, or
back into Power Query M) and as a checklist for review.

The origin of the logic is the Power Query template
`CompareMonths_changes_only_with_name.query`; where a requirement exists to preserve parity
with that M code, it is marked **[M-parity]**.

---

## 1. Purpose and scope

- **REQ-1.1** The tool compares the per-month tables inside a single `.xlsx` workbook and
  reports the rows that changed from one month to the next. It never compares two separate
  workbooks. *(`src/py_xldiff_compare_months_changes/__init__.py:1`)*
- **REQ-1.2** Each month is compared against the month immediately before it, walking the
  months in chronological order. **[M-parity]** *(`src/py_xldiff_compare_months_changes/diff.py:163`)*
- **REQ-1.3** By default the output holds only changed rows; unchanged rows and the first
  month's rows are suppressed. *(`src/py_xldiff_compare_months_changes/diff.py:176`)*
- **REQ-1.4** The tool must not require Excel, Power Query, or Office to be installed — the
  workbook is read directly, so the tool can run in CI or a cron job. *(`pyproject.toml:12`,
  dependency on `openpyxl` only)*

## 2. Workbook input

### 2.1 Month layouts

- **REQ-2.1.1** The canonical layout is real Excel Tables (ListObjects) named
  `tbl_Jan` … `tbl_Dec`. This is the layout the Power Query template requires, since
  `Excel.CurrentWorkbook()` only sees named tables. **[M-parity]** *(`src/py_xldiff_compare_months_changes/reader.py:83`)*
- **REQ-2.1.2** A fallback layout is supported: plain worksheets titled `Jan` … `Dec`, with the
  header in row 1. This covers the common workbook that never had tables defined.
  *(`src/py_xldiff_compare_months_changes/reader.py:108`)*
- **REQ-2.1.3** The two layouts are tried in order of preference — named tables first; the
  sheet fallback is used **only** when no named table matched at all. The layouts are never
  mixed within a single run. *(`src/py_xldiff_compare_months_changes/reader.py:148`)*
- **REQ-2.1.4** Table names and sheet titles match case-insensitively, and sheet titles are
  matched after trimming surrounding whitespace. *(`src/py_xldiff_compare_months_changes/reader.py:84`, `reader.py:113`)*
- **REQ-2.1.5** The table-name prefix is configurable (default `tbl_`), so a workbook using a
  different convention can still be read. *(`src/py_xldiff_compare_months_changes/reader.py:28`, `cli.py:52`)*
- **REQ-2.1.6** The set of months, and their order, is configurable; the default is the twelve
  calendar abbreviations `Jan … Dec` in calendar order. *(`src/py_xldiff_compare_months_changes/reader.py:23`, `cli.py:58`)*

### 2.2 Cell and row normalization

- **REQ-2.2.1** Cell values are read as values, not formulas — a cached formula result is used
  where present. *(`src/py_xldiff_compare_months_changes/reader.py:143`, `data_only=True`)*
- **REQ-2.2.2** String cells are stripped of surrounding whitespace; a string that is empty or
  whitespace-only becomes `None`. Non-string values pass through unchanged, preserving their
  Excel type (int, float, bool, datetime). *(`src/py_xldiff_compare_months_changes/reader.py:50`)*
- **REQ-2.2.3** The first row of a table or sheet is the header row. *(`src/py_xldiff_compare_months_changes/reader.py:63`)*
- **REQ-2.2.4** Trailing unnamed header columns are treated as Excel padding and dropped, not as
  data columns. *(`src/py_xldiff_compare_months_changes/reader.py:65`)*
- **REQ-2.2.5** An unnamed header cell that is *not* trailing is given the positional name
  `Column<N>` (1-based), so the row shape stays rectangular.
  *(`src/py_xldiff_compare_months_changes/reader.py:70`)*
- **REQ-2.2.6** A data row whose every cell is empty is a spacer and is skipped.
  *(`src/py_xldiff_compare_months_changes/reader.py:75`)*
- **REQ-2.2.7** A data row with fewer cells than the header is right-padded with `None`; a row
  with more cells than the header is truncated to the header width.
  *(`src/py_xldiff_compare_months_changes/reader.py:74`, `reader.py:77`)*
- **REQ-2.2.8** A month whose header row yields no columns at all is treated as absent, not as
  an empty month. *(`src/py_xldiff_compare_months_changes/reader.py:102`, `reader.py:119`)*

### 2.3 Validation and errors

- **REQ-2.3.1** A workbook path that does not exist is an error: `No such workbook: <path>`.
  *(`src/py_xldiff_compare_months_changes/reader.py:137`)*
- **REQ-2.3.2** A file that cannot be opened as `.xlsx` is an error naming the file and the
  underlying cause. *(`src/py_xldiff_compare_months_changes/reader.py:144`)*
- **REQ-2.3.3** A workbook in which no month could be located under either layout is an error
  that states both expected layouts. *(`src/py_xldiff_compare_months_changes/reader.py:154`)*
- **REQ-2.3.4** Every month that *was* found must contain the key column; if any found month
  lacks it, that is an error listing the offending months in month order and pointing at
  `--key`. A diff has no meaning without a join key. *(`src/py_xldiff_compare_months_changes/reader.py:160`)*
- **REQ-2.3.5** Months that are simply absent from the workbook are **not** an error — they are
  omitted, and the diff engine handles the gap (see REQ-3.5). **[M-parity]**
  *(`src/py_xldiff_compare_months_changes/reader.py:170`)*
- **REQ-2.3.6** All of the above are surfaced as a single error type (`WorkbookError`) so the
  CLI can report them uniformly. *(`src/py_xldiff_compare_months_changes/reader.py:32`)*
- **REQ-2.3.7** The workbook handle is always closed, including when reading raises.
  *(`src/py_xldiff_compare_months_changes/reader.py:151`)*

## 3. Diff engine

### 3.1 The join

- **REQ-3.1.1** Two consecutive months are compared by a full outer join on the key column.
  **[M-parity]** *(`src/py_xldiff_compare_months_changes/diff.py:109`)*
- **REQ-3.1.2** Rows are indexed by key; when a month contains duplicate keys, the last row
  wins, matching a join's last-write semantics. *(`src/py_xldiff_compare_months_changes/reader.py:45`)*
- **REQ-3.1.3** A row whose key is null is not a joinable row and is excluded from the index —
  and therefore from the diff. *(`src/py_xldiff_compare_months_changes/reader.py:47`)*
- **REQ-3.1.4** The key column defaults to `ID` and is configurable. *(`src/py_xldiff_compare_months_changes/reader.py:29`,
  `cli.py:45`)*

### 3.2 Statuses

- **REQ-3.2.1** A key present in the current month but absent from the previous month is
  **`Added`**. **[M-parity]** *(`src/py_xldiff_compare_months_changes/diff.py:115`)*
- **REQ-3.2.2** A key present in the previous month but absent from the current month is
  **`Removed`**. **[M-parity]** *(`src/py_xldiff_compare_months_changes/diff.py:125`)*
- **REQ-3.2.3** A key present in both months is **`Unchanged`**. **[M-parity]**
  *(`src/py_xldiff_compare_months_changes/diff.py:119`)*
- **REQ-3.2.4** Optionally (`--detect-modified`), a key present in both months whose non-key
  values differ is **`Modified`** instead of `Unchanged`. This is an extension beyond the M
  template. *(`src/py_xldiff_compare_months_changes/diff.py:120`, `diff.py:133`)*
- **REQ-3.2.5** The modified-comparison ignores the key column itself and compares only the
  columns declared by the *current* month. *(`src/py_xldiff_compare_months_changes/diff.py:139`)*
- **REQ-3.2.6** The statuses that constitute an actual change are exactly `Added`, `Removed`,
  and `Modified`. *(`src/py_xldiff_compare_months_changes/diff.py:33`)*

### 3.3 Which month's values a row carries

- **REQ-3.3.1** An `Added`, `Unchanged`, or `Modified` row carries the values from the
  **current** month. *(`src/py_xldiff_compare_months_changes/diff.py:116`, `diff.py:122`)*
- **REQ-3.3.2** A `Removed` row carries the values from the **previous** month — the month it
  was last seen in — because the current month has nothing to show for it. **[M-parity]**
  *(`src/py_xldiff_compare_months_changes/diff.py:127`)*
- **REQ-3.3.3** A `Removed` row is nevertheless labeled with the **current** month: the month
  in which the removal was observed. *(`src/py_xldiff_compare_months_changes/diff.py:127`)*

### 3.4 Base month

- **REQ-3.4.1** The first month present has no predecessor to compare against; all of its rows
  get the status **`Base Month`**. **[M-parity]** *(`src/py_xldiff_compare_months_changes/diff.py:102`)*
- **REQ-3.4.2** Base-month rows carry that month's values and are keyed normally; rows with a
  null key are excluded, consistent with REQ-3.1.3. *(`src/py_xldiff_compare_months_changes/diff.py:103`)*

### 3.5 Gaps in the month sequence

- **REQ-3.5.1** A month whose *immediate predecessor in the configured month list* is absent
  from the workbook is itself treated as a base month — the comparison short-circuits rather
  than reaching further back for the nearest available month. This mirrors `List.Generate` in
  the M template carrying `Prev` forward as null. **[M-parity]** *(`src/py_xldiff_compare_months_changes/diff.py:168`)*

### 3.6 Ordering

- **REQ-3.6.1** Output rows are grouped by month, in the configured month order.
  *(`src/py_xldiff_compare_months_changes/diff.py:163`)*
- **REQ-3.6.2** Within a month, rows are sorted by key in a human reading order: numeric keys
  first and in numeric order, then text keys case-insensitively, then null keys last. Numeric
  *strings* sort with the numbers. Booleans sort with the text. This explicit ranking exists
  because Excel yields ints, floats, strings, and blanks in the same column, and those are not
  mutually comparable in Python 3. *(`src/py_xldiff_compare_months_changes/diff.py:76`, `diff.py:129`)*

### 3.7 Output columns

- **REQ-3.7.1** The output column order is: `Month`, then the key column, then
  `Change_Status`, then every remaining data column. *(`src/py_xldiff_compare_months_changes/diff.py:66`)*
- **REQ-3.7.2** The trailing data columns are the union of the columns of all months that were
  read, in first-seen order across the months (the key column excluded, since it is already
  emitted in position 2). A column that exists in only one month therefore still appears.
  *(`src/py_xldiff_compare_months_changes/diff.py:171`)*
- **REQ-3.7.3** A row that lacks one of the union's columns emits `None` for it rather than
  failing. *(`src/py_xldiff_compare_months_changes/diff.py:53`)*

### 3.8 Filtering

- **REQ-3.8.1** By default, only rows whose status is a change status (REQ-3.2.6) are emitted;
  `Unchanged` and `Base Month` rows are dropped. **[M-parity]** *(`src/py_xldiff_compare_months_changes/diff.py:176`)*
- **REQ-3.8.2** With `--all`, every row is emitted, including `Unchanged` and `Base Month`.
  *(`src/py_xldiff_compare_months_changes/cli.py:68`, `diff.py:148`)*

## 4. Output formats

- **REQ-4.1** Four formats are supported: `table`, `csv`, `json`, `xlsx`.
  *(`src/py_xldiff_compare_months_changes/writer.py:19`)*
- **REQ-4.2** The format is chosen as follows: an explicit `--format` wins; otherwise it is
  inferred from the `--output` extension (`.xlsx`/`.xlsm` → xlsx, `.json` → json,
  `.csv`/`.txt` → csv); otherwise it defaults to `table`. *(`src/py_xldiff_compare_months_changes/writer.py:30`)*
- **REQ-4.3** `table` renders a fixed-width, column-aligned table for the terminal, with a
  header row and a dashed rule sized to the widest cell in each column. Trailing whitespace is
  stripped from each line. *(`src/py_xldiff_compare_months_changes/writer.py:56`)*
- **REQ-4.4** `csv` renders standard CSV with a header row. *(`src/py_xldiff_compare_months_changes/writer.py:74`)*
- **REQ-4.5** `json` renders an array of objects — one per changed row, keys in header order —
  indented by 2. *(`src/py_xldiff_compare_months_changes/writer.py:83`)*
- **REQ-4.6** Date, time, and datetime cell values are serialized as ISO-8601 strings in every
  text format, since Excel dates arrive as datetimes and are not natively JSON- or CSV-safe.
  *(`src/py_xldiff_compare_months_changes/writer.py:45`)*
- **REQ-4.7** A `None` value renders as an empty string in the `table` format.
  *(`src/py_xldiff_compare_months_changes/writer.py:52`)*
- **REQ-4.8** `xlsx` is a binary format and cannot be rendered to a string; asking for it via
  the text path is a programming error. *(`src/py_xldiff_compare_months_changes/writer.py:143`)*

### 4.1 The .xlsx writer

- **REQ-4.1.1** The result is written to a single worksheet named `Changes`.
  *(`src/py_xldiff_compare_months_changes/writer.py:94`)*
- **REQ-4.1.2** The header row is styled to match the Power Query output: bold white text on an
  orange fill (`ED7D31`), left-aligned. *(`src/py_xldiff_compare_months_changes/writer.py:21`, `writer.py:105`)*
- **REQ-4.1.3** Data rows are fill-coded by status: `Added` green (`E2EFDA`), `Removed` red
  (`FCE4E4`), `Modified` amber (`FFF2CC`). Any other status is left unfilled.
  *(`src/py_xldiff_compare_months_changes/writer.py:23`, `writer.py:110`)*
- **REQ-4.1.4** Column widths are auto-sized to the longest value in the column plus padding,
  capped at 40. *(`src/py_xldiff_compare_months_changes/writer.py:116`)*
- **REQ-4.1.5** The output range is registered as an Excel Table named `tbl_Changes`, styled
  `TableStyleMedium2` with row stripes — so the output workbook can itself be fed back in as
  input. *(`src/py_xldiff_compare_months_changes/writer.py:123`)*
- **REQ-4.1.6** An Excel Table requires at least one data row. When the diff is empty, the range
  falls back to an autofilter instead, so a zero-change run still produces a valid workbook.
  *(`src/py_xldiff_compare_months_changes/writer.py:120`, `writer.py:128`)*
- **REQ-4.1.7** The header row is frozen. *(`src/py_xldiff_compare_months_changes/writer.py:131`)*

## 5. Command line interface

- **REQ-5.1** The executable is `xldiff` and takes the workbook path as its only positional
  argument. *(`pyproject.toml:18`, `cli.py:32`)*
- **REQ-5.2** The package is also runnable as `python -m py_xldiff_compare_months_changes`. *(`src/py_xldiff_compare_months_changes/__main__.py`)*
- **REQ-5.3** Options:

  | Option | Effect | Default |
  | --- | --- | --- |
  | `-o`, `--output PATH` | Write the result to a file | print to stdout |
  | `-f`, `--format FMT` | `table` \| `csv` \| `json` \| `xlsx` | inferred (REQ-4.2) |
  | `-k`, `--key COLUMN` | Column identifying a row across months | `ID` |
  | `--table-prefix PREFIX` | Prefix of the per-month table names | `tbl_` |
  | `--months LIST` | Comma-separated months, in order, to compare | `Jan..Dec` |
  | `--detect-modified` | Also report same-key/changed-value rows as `Modified` | off |
  | `--all` | Include `Unchanged` and `Base Month` rows too | off |
  | `--version` | Print the version and exit | — |

  *(`src/py_xldiff_compare_months_changes/cli.py:33`–`73`)*
- **REQ-5.4** `--months` is validated: unrecognized month names are an error that lists them
  alongside the accepted names, and fewer than two months is an error, since there is nothing to
  compare. *(`src/py_xldiff_compare_months_changes/cli.py:77`)*
- **REQ-5.5** `--format xlsx` without `--output` is an error — there is nowhere to write the
  binary. *(`src/py_xldiff_compare_months_changes/cli.py:113`)*
- **REQ-5.6** With no `--output`, the rendered result goes to stdout.
  *(`src/py_xldiff_compare_months_changes/cli.py:117`)*
- **REQ-5.7** With `--output`, the parent directory is created if it does not exist, and text
  formats are written UTF-8 encoded. *(`src/py_xldiff_compare_months_changes/cli.py:120`)*
- **REQ-5.8** With `--output`, a one-line summary — the number of changed rows, the months that
  were found, and the destination — is printed to **stderr**, keeping stdout clean for the
  data. *(`src/py_xldiff_compare_months_changes/cli.py:126`)*
- **REQ-5.9** All `WorkbookError`s are reported to stderr as `xldiff: <message>` — never as a
  traceback. *(`src/py_xldiff_compare_months_changes/cli.py:107`)*
- **REQ-5.10** Exit codes: `0` on success, `1` on any handled error. *(`src/py_xldiff_compare_months_changes/cli.py:15`)*

## 6. Public API

- **REQ-6.1** The package exposes the diff as a library, not only as a CLI: `read_workbook`,
  `diff_tables`, `compare_months`, the `MonthTable` / `ChangeRow` / `DiffResult` types, the
  status constants, `MONTHS`, and `WorkbookError`. *(`src/py_xldiff_compare_months_changes/__init__.py:10`)*
- **REQ-6.2** Reading, diffing, and rendering are separate stages with no coupling between them:
  the reader knows nothing of statuses, the diff engine nothing of formats. A new input layout
  or a new output format must be addable without touching the other two.
  *(module boundaries: `reader.py`, `diff.py`, `writer.py`)*

## 7. Build and developer workflow

- **REQ-7.1** The project targets Python ≥ 3.9 and depends only on `openpyxl` at runtime;
  `pytest` is the sole dev dependency. *(`pyproject.toml:11`–`16`)*
- **REQ-7.2** `make` targets provide the whole workflow: `setup` (venv), `install` (editable
  install), `test`, `sample` (regenerate the example workbook), `run`, `run-print`, `run-csv`,
  `run-json`, and `clean`. *(`Makefile`)*
- **REQ-7.3** `run` and its per-format variants accept `FILE=` to select the workbook (default:
  the generated example) and `ARGS=` to pass extra flags through. *(`Makefile`)*
- **REQ-7.4** The example workbook is generated, not committed as a binary blob, and is
  regenerated on demand from `scripts/make_sample.py`. *(`Makefile`, `scripts/make_sample.py`)*
- **REQ-7.5** `make help` lists the targets with their descriptions. *(`Makefile`)*
