# Parity: the bash suite vs the Python suite

Both suites implement the same contract — `py-xlsx-diff-commons/reference/CONTRACT.md` — and that
document remains the single spec. This file records how closely the shell implementation actually
matches, where it deliberately does not, and what shell cannot do at all.

Everything below was measured, not assumed.

## Measured parity

**45 of 45 outputs byte-identical**: 5 fixtures × 3 formats (`table`, `csv`, `json`) × 3 flag
sets (default, `--all`, `--detect-modified`).

| Fixture | Layout | What it exercises |
| --- | --- | --- |
| `sample.xlsx` | named tables | The canonical 3-month workbook; the golden output |
| `sheets.xlsx` | sheets | The fallback layout — no named tables at all |
| `gap.xlsx` | named tables | Jan + Mar, no Feb → Mar is a base month → **empty diff** |
| `messy.xlsx` | sheets | Duplicate key, null key, spacer row, ragged columns |
| `tables_offset.xlsx` | named tables | `tbl_Jan` on a sheet called `Sheet1`, ref `C3:E5` |

**Cross-validation, both directions** — each implementation verifies the other's output file:

- `.xlsx` written by bash → **passes** the Python verifier, on all five fixtures.
- `.xlsx` written by Python → **passes** the bash verifier, on all five fixtures.

That is the strongest check available here: the file is read back by an implementation that
shares no code with the one that wrote it.

## Known divergences

**JSON trailing newline (1 byte).** Python's `--output` writes `json.dumps(...)` with no trailing
newline. The shell version ends the file with one, per POSIX convention. The JSON parses
identically. Bash's JSON *is* byte-identical to Python's **stdout**, which does add the newline.

**Numeric-looking strings in JSON.** The shell reader flattens every cell to text, then re-infers
"is this a number?" when emitting JSON. So a cell that Excel stored as the *string* `"00123"`
would be emitted by Python as `"00123"` (it kept the type) and by bash as… also `"00123"`, since
the leading zero fails the number test — but a cell stored as the string `"123"` would come out
as `123`. Python preserves the distinction because openpyxl hands it the cell type; bash cannot,
having discarded it. In practice Excel stores numbers as numbers, so this only bites a workbook
that deliberately stores numeric text. If that matters to you, use the Python suite.

**CSV line endings.** Both emit CRLF (RFC-4180), matching Python's `csv` module. Note that
Python's *stdout* CSV has one spurious extra blank line — `print()` appends `\n` to a string that
already ends in `\r\n`. The file artifact does not. Bash matches the file artifact.

## What shell does not do

**Dates.** Excel stores a date as a serial number, and whether it *is* a date lives in
`styles.xml` (the cell's number format), not in the cell. The Python reader gets a real
`datetime` from openpyxl and serializes it as ISO-8601 (REQ-4.6). The shell reader would have to
parse `styles.xml`, resolve the `numFmtId`, decide which formats mean "date", and then implement
the 1900-leap-year bug. It does not. **A date column comes out of the bash suite as the raw
serial number.** This is the one substantive gap. If your workbook has dates, use the Python
suite — or add the column as text.

**Power Query M injection.** `py-powerquery-m-diff-inject` has no bash twin, and deliberately so.
The primitives all exist (`base64`, `dd`, `printf` for a little-endian uint32, `iconv` for
UTF-16, `zip`), so it is not *impossible* — but it means binary surgery on a length-prefixed blob
holding a nested ZIP, and shell buys nothing there over Python's `zipfile`. Use the Python skill.

## Why a shell version exists at all

It needs `unzip`, `sed`, `awk`, `sort`, `cut`, and `zip` — all of which are already on any box
that can run a cron job. No Python, no `pip install openpyxl`, no virtualenv, nothing to
provision. On a locked-down build agent or an appliance where you cannot install packages, that
is the difference between running and not running.

The cost is the two gaps above (dates, M injection) and the fact that an awk implementation of a
join is harder to change safely than a Python one. If you have Python, prefer the Python suite. If
you don't, this one produces the same answer.

## Reproducing the parity check

```bash
python3 ../../py-xlsx-diff-commons/scripts/make_fixtures.py fixtures

for f in sample sheets gap messy; do
  for fmt in table json; do
    python3 ../../py-xlsx-diff-commons/scripts/xldiff_core.py fixtures/$f.xlsx -f $fmt > /tmp/py
    ./xldiff.sh                                                fixtures/$f.xlsx -f $fmt > /tmp/sh
    diff -q /tmp/py /tmp/sh && echo "ok $f/$fmt"
  done
done
```

Compare CSV against Python's **file** output (`-o /tmp/py`), not its stdout, for the reason above.
