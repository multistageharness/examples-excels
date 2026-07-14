---
name: bash-xlsx-month-diff
description: Take an Excel workbook holding one table per month and extract only the rows that changed month over month — added, removed, optionally modified — into a NEW file (.xlsx, .csv, .json), using nothing but unzip/sed/awk/zip. No Python, no openpyxl, no Excel, nothing to pip install. The entry point of the bash suite: inspect, diff, write, verify. Use on a locked-down build agent, container, or appliance where you cannot install packages, when asked to diff months in a spreadsheet with shell only, or when a cron job must run somewhere Python is not available.
license: MIT
compatibility: POSIX shell + unzip, zip, sed, awk, sort, cut. Dates come out as raw serial numbers — see bash-xlsx-diff-commons/reference/PARITY.md.
metadata:
  role: entry-point
dependencies:
  - bash-xlsx-diff-commons
---

# bash-xlsx-month-diff

Workbook in, changes file out — with nothing installed. An `.xlsx` is a ZIP of XML, so shell can
read one; and it is *also* a ZIP of XML on the way out, so shell can write one too.

```
sample.xlsx  ──►  inspect  ──►  diff  ──►  changes.xlsx
 tbl_Jan          layout?       Added        Month ID Change_Status Status   Owner
 tbl_Feb          key?          Removed      Feb   103 Removed      Active   Charlie
 tbl_Mar          gaps?         Modified     Mar   102 Removed      Inactive Bob
```

This is the shell twin of `py-xlsx-month-diff`. Same contract, same output — **45 of 45 outputs
are byte-identical to the Python engine**, and each implementation's `.xlsx` passes the other's
verifier. Pick this one when you cannot install Python or an openpyxl wheel; pick the Python one
when you can (see *Which suite* below).

## The workflow

Paths are relative to this skill's directory. `$WB` is the workbook.

### 1. Inspect before you diff

```bash
../bash-xlsx-workbook-inspect/scripts/inspect.sh "$WB"
```

Exit 0 means diffable. Read the warnings — especially a gap in the month sequence, which is the
one that silently produces an empty result.

### 2. Diff it into a new file

```bash
ENGINE=../bash-xlsx-diff-commons/scripts/xldiff.sh
WRITE=../bash-xlsx-diff-export/scripts/write_xlsx.sh

"$ENGINE" "$WB"                                  # print it
"$ENGINE" "$WB" -f csv  > changes.csv            # or json
"$ENGINE" "$WB" -f tsv | "$WRITE" changes.xlsx   # styled workbook, colour-coded by status
```

The `.xlsx` path pipes TSV into the writer — that is the seam between the engine and the output
format. Add `--detect-modified` to catch rows whose key stayed but whose values changed, and
`--all` to keep `Unchanged` and `Base Month` rows.

### 3. Verify what you wrote

```bash
../bash-xlsx-diff-verify/scripts/verify.sh "$WB" changes.xlsx
```

Exit 0 = the file genuinely describes that workbook. Cheap, and it catches the `Removed`-row bug
that makes a wrong file look completely right.

## What you get

```
Month  ID   Change_Status  Status    Owner
-----  ---  -------------  --------  -------
Feb    103  Removed        Active    Charlie
Feb    105  Added          Active    Eve
Mar    102  Removed        Inactive  Bob
Mar    106  Added          New       Frank
```

In `.xlsx`: `Added` green, `Removed` red, `Modified` amber, header frozen, and the range
registered as an Excel Table (`tbl_Changes`) so the output can be fed back in as input.

## Three things that will surprise you

**A `Removed` row carries the *previous* month's values.** `Mar / 102 / Removed / Inactive / Bob`
means Bob disappeared in March, and `Inactive` is what he was in February — the last month he
existed. The row is labelled with the month the removal was *observed*, but the data comes from
the month it was last *seen*, because March has nothing to show for a row that is gone from it.

**A gap in the months yields no changes, not an error.** A month whose immediate predecessor is
absent is treated as a base month; the comparison short-circuits. Jan + Mar with no Feb produces
an **empty** diff. Faithful to `List.Generate` in the M template — and why step 1 exists.

**`Modified` is opt-in.** By default a row whose key survived but whose values changed is
`Unchanged` and is filtered out. That is M-parity with the original template.

## Which suite — bash or Python?

| | **bash** (this) | **Python** (`py-xlsx-month-diff`) |
| --- | --- | --- |
| Install anything? | **No** — unzip/sed/awk/zip are already there | `pip install openpyxl` |
| Named-table + sheet layouts | Yes, both | Yes, both |
| Output `.xlsx` / `.csv` / `.json` | Yes | Yes |
| **Dates** | **Raw serial numbers** | Real dates, ISO-8601 |
| Power Query M injection | No | Yes (`py-powerquery-m-diff-inject`) |
| Easy to modify safely | Less so — it is awk | Yes |

**Prefer the Python suite when you can install packages.** Reach for this one when you cannot — a
locked-down CI runner, a minimal container, an appliance — or when your workbook has no dates and
you would rather ship one script than a virtualenv.

The date gap is the real one: whether a cell is a date lives in `styles.xml`, not in the cell, so
shell would have to parse number formats and reimplement Excel's 1900 leap-year bug to decode it.
Measured parity and both gaps in full: `bash-xlsx-diff-commons/reference/PARITY.md`.

## Related skills

`bash-xlsx-diff-commons` (engine + reader) · `bash-xlsx-workbook-inspect` (step 1) ·
`bash-xlsx-diff-export` (step 2's writer) · `bash-xlsx-diff-verify` (step 3) ·
`py-xlsx-month-diff` (the Python twin)
