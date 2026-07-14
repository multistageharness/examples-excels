---
name: bash-xlsx-diff-export
description: Build a styled .xlsx from TSV using nothing but zip and heredocs — status-colour-coded rows, bold-on-orange frozen header, auto-sized columns, and the range registered as an Excel Table (tbl_Changes) so the output can be fed back in as input. An .xlsx is a ZIP of XML parts, so a shell script can emit one provided it writes every part the spec requires and gets the relationships right. Use to write the diff to a real workbook without Python or openpyxl, when a build agent cannot install packages, or to understand the minimum set of XML parts a valid .xlsx needs.
license: MIT
compatibility: POSIX shell + zip, awk. No Python, no openpyxl, no Excel. Verified by reading the output back with openpyxl and with the bash verifier.
metadata:
  role: output
dependencies:
  - bash-xlsx-diff-commons
---

# bash-xlsx-diff-export

There is no binary format to marshal — an `.xlsx` is a ZIP of XML. So shell can write one.

```bash
../bash-xlsx-diff-commons/scripts/xldiff.sh book.xlsx -f tsv | ./scripts/write_xlsx.sh changes.xlsx
```

TSV in on stdin, workbook out. That is the whole interface: the engine emits TSV, this turns TSV
into a styled worksheet, and the two are decoupled.

For text formats you do not need this skill at all — the engine emits them directly:

```bash
xldiff.sh book.xlsx -f csv  > changes.csv     # RFC-4180, CRLF
xldiff.sh book.xlsx -f json > changes.json    # numbers stay numbers, blanks are null
xldiff.sh book.xlsx -f tsv  > changes.tsv     # the pipe format
xldiff.sh book.xlsx                           # fixed-width table, for reading
```

## What the .xlsx contains

Matching the Python writer's contract exactly:

- One sheet, named **`Changes`**.
- Header **bold white on orange** (`ED7D31`), left-aligned, and **frozen**.
- Rows **fill-coded by status** — `Added` green (`E2EFDA`), `Removed` red (`FCE4E4`), `Modified`
  amber (`FFF2CC`). Any other status is left unfilled.
- Columns auto-sized to the longest value, capped at 40.
- The range registered as a real Excel Table named **`tbl_Changes`**, styled `TableStyleMedium2`.

That last point matters: because the output is a *named table*, the changes file satisfies the
suite's own input contract. Power Query only ever sees named tables, so this is what makes the
output re-consumable.

Values are written as **inline strings** (`t="inlineStr"`) except pure numbers, which go in as
numbers. That avoids a `sharedStrings.xml` part entirely — one less part to keep consistent — and
keeps the types honest, so a reader gets `103` as an integer rather than the string `"103"`.

## The parts a valid .xlsx needs

The minimum set, and every one of them is required — omit any and Excel calls the file corrupt:

```
[Content_Types].xml              declares the type of every part; nothing may be undeclared
_rels/.rels                      package root -> the workbook
xl/workbook.xml                  the sheet list
xl/_rels/workbook.xml.rels       workbook -> its sheets and styles
xl/worksheets/sheet1.xml         the cells
xl/styles.xml                    fonts, fills, and the cellXfs the cells index into
xl/tables/table1.xml             the Excel Table         (only when there is >= 1 data row)
xl/worksheets/_rels/sheet1.xml.rels   sheet -> its table (only when there is >= 1 data row)
```

Two traps worth knowing, both of which this script handles:

**Style indexes are positional.** A cell says `s="3"`, which means "the 4th entry in `cellXfs`".
The order of the `<xf>` elements *is* the API. Insert one in the middle and every cell silently
re-styles.

**An Excel Table requires at least one data row.** With a header and nothing under it, the table
part makes the workbook invalid. On an empty diff the script drops the table and falls back to an
`autoFilter`, so a zero-change run still produces a workbook that opens. (A zero-change run is not
a bug — a gap in the month sequence produces one legitimately.)

## How it was verified

Not by inspection — by reading the output back with tools that share no code with it:

- **openpyxl** opens it and reports the right sheet name, dimensions, frozen pane, `tbl_Changes`
  registration, header fill, per-status row fills, and integer-typed keys.
- The **Python verifier** (`py-xlsx-diff-verify`) passes on the bash-built workbook, across all
  five fixtures — including the empty-diff case.
- `unzip -t` reports a valid archive.

What that does *not* prove is that Microsoft Excel itself opens it happily; no Excel was
available here. openpyxl agreeing is strong evidence, not a guarantee. Open one by hand before
you wire this into something that matters.

## Related skills

`bash-xlsx-diff-commons` (the engine that feeds it) · `bash-xlsx-diff-verify` (prove the file is
right) · `py-xlsx-diff-export` (the Python twin)
