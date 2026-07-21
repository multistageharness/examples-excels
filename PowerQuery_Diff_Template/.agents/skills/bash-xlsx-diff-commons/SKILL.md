---
name: bash-xlsx-diff-commons
description: The shell engine and reader for the bash xlsx month-diff suite — no Python, no openpyxl, no Excel, just unzip/sed/awk/sort. Owns xlsx2tsv.sh (the reader — resolves the named-Excel-Table layout with its ref range, falls back to sheets, resolves shared strings, and handles sparse cells) and xldiff.sh (the engine — joins each month to the one before it and emits table/csv/tsv/json). Load when working on a box where you cannot install Python or pip packages, when another bash- skill needs the engine, or when you need to know how closely the shell output matches the Python suite (reference/PARITY.md). Other bash- skills depend on this one.
license: MIT
compatibility: POSIX shell + unzip, sed, awk (BSD/one-true-awk or gawk), sort, cut. No Python, no Excel. Dates are NOT decoded — see reference/PARITY.md.
metadata:
  role: commons
  consumer-pattern: dependency
---

# bash-xlsx-diff-commons

The shell twin of `py-xlsx-diff-commons`. Same contract, same output, zero dependencies you have
to install — it needs `unzip`, `sed`, `awk`, `sort`, and `cut`, all of which are already on any
machine that can run a cron job.

## What is here

| Path | What it is |
| --- | --- |
| `scripts/xlsx2tsv.sh` | The reader. Dumps a sheet, a named table, or a *month* as TSV. Owns the layout rule. |
| `scripts/xldiff.sh` | The engine. Joins each month to the one before it; emits `table`/`csv`/`tsv`/`json`. |
| `reference/PARITY.md` | How closely this matches the Python suite, measured — and the two things it does not do. |

The rules themselves live in **`py-xlsx-diff-commons/reference/CONTRACT.md`**. That is the one
spec; this is a second implementation of it, not a second definition.

## Using it

```bash
./scripts/xldiff.sh WORKBOOK.xlsx                       # print the changes
./scripts/xldiff.sh WORKBOOK.xlsx -f csv                # or tsv / json / table
./scripts/xldiff.sh WORKBOOK.xlsx -f tsv | ../bash-xlsx-diff-export/scripts/write_xlsx.sh out.xlsx
```

| Option | Effect | Default |
| --- | --- | --- |
| `-k, --key COLUMN` | The column identifying a row across months | `ID` |
| `-f, --format FMT` | `table` \| `csv` \| `tsv` \| `json` | `table` |
| `--table-prefix P` | Prefix of the per-month table names | `tbl_` |
| `--detect-modified` | Also report same-key/changed-value rows as `Modified` | off |
| `--all` | Include `Unchanged` and `Base Month` rows | off |

`tsv` is the pipe format — it is what `write_xlsx.sh` and `verify.sh` consume.

The reader is useful on its own:

```bash
./scripts/xlsx2tsv.sh BOOK.xlsx --list          # sheet names
./scripts/xlsx2tsv.sh BOOK.xlsx --layout        # named-tables | sheets | none
./scripts/xlsx2tsv.sh BOOK.xlsx --month Jan     # that month, resolved through the layout rule
./scripts/xlsx2tsv.sh BOOK.xlsx --sheet Sheet1  # a raw sheet, whole grid
```

## The three things a naive shell reader gets wrong

An `.xlsx` is a ZIP of XML, so `unzip -p book.xlsx xl/worksheets/sheet1.xml | grep '<v>'` looks
like it should work. It does not, for three reasons, and this reader handles all three.

**Shared strings.** A cell with `t="s"` does not contain its value — it contains an *index* into
`xl/sharedStrings.xml`. Grepping `<v>` on a text column yields `0 1 2 3`, not names. The reader
builds the string table first and resolves through it.

**Sparse cells.** A blank cell is not an empty `<c/>` — it is **absent from the XML entirely**.
Cells carry their address (`<c r="C3">`), so reading them positionally shifts every row after the
first gap one column to the left, silently. The reader places each cell by its address into a
grid and fills the holes.

**Named tables are not sheets.** In the canonical layout the month lives in an Excel Table called
`tbl_Jan`, which carries its own `ref` range (`C3:E5`) and can sit on a sheet called anything at
all — `Sheet1`, `Data`, whatever. Finding months by sheet *name* silently misses them. The reader
walks each worksheet's rels to its table parts, reads the `displayName` and `ref`, and clips to
that range. Sheets named `Jan`…`Dec` are the *fallback*, used only when no table matched any
month — the two layouts are never mixed.

## Parity, honestly

**45 of 45 outputs are byte-identical to the Python engine** (5 fixtures × 3 formats × 3 flag
sets), and each implementation's `.xlsx` passes the *other's* verifier.

Two things this does not do, and you should know before you pick it:

- **Dates come out as raw serial numbers.** Whether a cell is a date lives in `styles.xml`, not
  in the cell, so decoding one means parsing number formats and reimplementing the 1900 leap-year
  bug. The Python reader gets a real `datetime` for free from openpyxl. If your workbook has
  dates, use the Python suite.
- **No M-code injection.** `py-powerquery-m-diff-inject` has no bash twin on purpose — see
  `reference/PARITY.md`.

Full detail, including how to re-run the parity check: `reference/PARITY.md`.

## Related skills

`bash-xlsx-month-diff` (the entry point) · `bash-xlsx-workbook-inspect` (pre-flight) ·
`bash-xlsx-diff-export` (the `.xlsx` writer) · `bash-xlsx-diff-verify` (prove it is right) ·
`py-xlsx-diff-commons` (the spec, and the suite to prefer when you have Python)
