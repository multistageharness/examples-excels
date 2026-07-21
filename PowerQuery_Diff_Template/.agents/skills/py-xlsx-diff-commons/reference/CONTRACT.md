# The diff contract

The rules every skill in this suite obeys. Each rule cites the requirement it implements in
`REQ.md` (in the reference project, `v1/automated/py_xldiff_compare_months_changes/`). If you change one of these,
you have changed the contract — update this file and `py-xlsx-diff-verify` with it.

## Input: what a workbook must look like

One table per month. Two layouts, tried in this order and **never mixed** (REQ-2.1.3):

1. **Named Excel Tables** — `tbl_Jan` … `tbl_Dec` (REQ-2.1.1). The prefix is configurable
   (REQ-2.1.5). This is the only layout Power Query can read, because `Excel.CurrentWorkbook()`
   sees named tables and nothing else.
2. **Plain sheets** — titled `Jan` … `Dec`, header in row 1 (REQ-2.1.2). The fallback, used only
   when *no* named table matched. This is the common real-world workbook, and Power Query
   cannot read it at all.

Names match case-insensitively; sheet titles are trimmed first (REQ-2.1.4).

Every month found must contain the key column (default `ID`, REQ-3.1.4) or the run fails with a
message naming the offending months (REQ-2.3.4). A month that is simply *absent* is not an error
(REQ-2.3.5) — see "gaps" below.

## Normalization: what the reader does to your cells

| Rule | Behavior | REQ |
| --- | --- | --- |
| Values, not formulas | A cached formula result is read; the formula is not | 2.2.1 |
| Whitespace | Strings are stripped; empty/whitespace-only becomes `None` | 2.2.2 |
| Header | Row 1 is the header | 2.2.3 |
| Trailing blank headers | Dropped as Excel padding, not read as data columns | 2.2.4 |
| Interior blank header | Named positionally, `Column<N>` (1-based) | 2.2.5 |
| Blank row | A row of all-empty cells is a spacer and is skipped | 2.2.6 |
| Ragged row | Short rows are right-padded with `None`; long rows are truncated | 2.2.7 |
| Empty header row | The month is treated as absent, not as an empty month | 2.2.8 |
| Duplicate key | The **last** row wins, matching a join's last-write semantics | 3.1.2 |
| Null key | Not a joinable row — excluded from the index, and from the diff | 3.1.3 |

## The diff: five statuses

Each month is full-outer-joined to **the month immediately before it** (REQ-1.2, REQ-3.1.1).

| Status | Meaning | Values come from | REQ |
| --- | --- | --- | --- |
| `Added` | Key is in this month, not the previous one | current month | 3.2.1 / 3.3.1 |
| `Removed` | Key was in the previous month, gone from this one | **previous** month | 3.2.2 / 3.3.2 |
| `Modified` | Key in both, a non-key value changed (`--detect-modified` only) | current month | 3.2.4 |
| `Unchanged` | Key in both, nothing changed | current month | 3.2.3 |
| `Base Month` | The first month present — nothing precedes it | that month | 3.4.1 |

Only `Added`, `Removed`, and `Modified` count as changes (REQ-3.2.6). `Unchanged` and
`Base Month` are dropped unless `--all` is passed (REQ-3.8.1, REQ-3.8.2).

### The one rule that is easy to get backwards

**A `Removed` row is labeled with the month the removal was *observed* in (REQ-3.3.3), but
carries the values from the month *before* it — the last month the row actually existed
(REQ-3.3.2).**

This is the entire point of the `with_name` variant. The current month has nothing to show for a
row that is gone from it, so naively taking "the current month's values" yields a row of blanks
with an ID and no name. Concretely, in the reference sample:

    Mar  102  Removed  Inactive  Bob

Bob was `Active` in Jan, flipped to `Inactive` in Feb, and vanished in Mar. His `Removed` row is
labeled **Mar** (where he disappeared) but carries **Feb's** values (`Inactive`, the last thing
that was true of him). Emitting Jan's `Active`, or blanks, is the classic bug — and it still
produces a plausible-looking file, which is why `py-xlsx-diff-verify` checks this rule against the
source workbook rather than trusting the engine.

### Gaps in the month sequence

A month whose **immediate predecessor in the configured month list** is absent is treated as a
base month — the comparison short-circuits rather than reaching further back for the nearest
available month (REQ-3.5.1). A workbook with Jan and Mar but no Feb therefore yields **zero
changes**: Jan is the base month, and Mar's predecessor (Feb) is missing, so Mar is a base month
too. This mirrors `List.Generate` in the M template carrying `Prev` forward as null.

This surprises people. `py-xlsx-workbook-inspect` warns about it explicitly.

## Output: shape and order

Column order is `Month`, the key column, `Change_Status`, then every remaining data column
(REQ-3.7.1). The trailing columns are the **union** across all months in first-seen order, so a
column that exists in only one month still appears; rows lacking it emit blank (REQ-3.7.2,
REQ-3.7.3).

Rows are grouped by month in month order (REQ-3.6.1). Within a month they sort by key in reading
order: numbers first and numerically, then text case-insensitively, then nulls last (REQ-3.6.2).
Numeric *strings* sort with the numbers; booleans sort with the text. The explicit ranking exists
because Excel hands back ints, floats, strings, and blanks in one column, and Python 3 will not
compare those to each other.

## Formats

`table`, `csv`, `json`, `xlsx` (REQ-4.1). An explicit `--format` wins; otherwise it is inferred
from the output extension (`.xlsx`/`.xlsm` → xlsx, `.json` → json, `.csv`/`.txt` → csv);
otherwise `table` (REQ-4.2). Dates serialize as ISO-8601 in every text format (REQ-4.6), and
`None` renders as an empty string (REQ-4.7).

The `.xlsx` writer is the interesting one: one sheet named `Changes` (REQ-4.1.1), a bold-white-on
-orange (`ED7D31`) header (REQ-4.1.2), rows fill-coded by status — `Added` green (`E2EFDA`),
`Removed` red (`FCE4E4`), `Modified` amber (`FFF2CC`) (REQ-4.1.3) — auto-sized columns capped at
40 (REQ-4.1.4), a frozen header (REQ-4.1.7), and the range registered as an Excel Table named
`tbl_Changes` (REQ-4.1.5) so **the output can be fed back in as input**. An Excel Table needs at
least one data row, so a zero-change run falls back to an autofilter rather than emitting an
invalid workbook (REQ-4.1.6).

## Errors and exit codes

Everything that makes a workbook undiffable is one error type (REQ-2.3.6), reported as
`xldiff: <message>` on stderr — never a traceback (REQ-5.9). Exit `0` on success, `1` on any
handled error (REQ-5.10). With `-o`, the data goes to the file and a one-line summary goes to
**stderr**, keeping stdout clean for piping (REQ-5.8).
