---
name: py-xlsx-diff-verify
description: Prove that an emitted diff file (.xlsx/.csv/.json) actually describes the workbook it was derived from, before anyone relies on it. Runs two independent checks — a PARITY pass that re-runs the engine and compares row for row (catching a stale, truncated, hand-edited, or wrong-workbook file) and an INVARIANT pass that re-derives each row's claim from the source workbook's raw month tables without the engine (catching an engine bug, most importantly a Removed row carrying the wrong month's values). Exits non-zero on any mismatch. Use before shipping or committing a changes file, in CI, after changing the diff engine, or when a diff looks plausible but you do not trust it.
license: MIT
compatibility: Python >= 3.9 with openpyxl.
metadata:
  role: verification
dependencies:
  - py-xlsx-diff-commons
---

# py-xlsx-diff-verify

A diff file that is wrong still looks right. Every row has a plausible month, a plausible status,
and plausible values — that is precisely what makes a bad one dangerous. This checks it.

```bash
python3 scripts/verify_diff.py SOURCE.xlsx CHANGES.xlsx [-k ID] [--detect-modified] [--all]
```

`SOURCE` is the workbook that was diffed; `CHANGES` is the `.xlsx`, `.csv`, or `.json` it was
written to (the format is read back from the extension). Exit **0** = every check passed. Exit
**1** = at least one failed, and each failure is printed with the row it is about.

Pass the same `--detect-modified` / `--all` / `-k` flags the diff was produced with — the
verifier has to know what the file was *supposed* to contain.

## Two checks, and the difference matters

**PARITY** — re-run the engine over `SOURCE` and compare to `CHANGES` row for row, including the
header order. This catches a stale file, a truncated one, a hand-edited one, or one produced from
a different workbook entirely.

It does **not** catch an engine bug. It is comparing the engine against itself: if the engine is
wrong, both sides are wrong in the same way and parity passes happily. That is the trap, and it
is why there is a second check.

**INVARIANT** — go back to `SOURCE`'s raw month tables and re-derive, from first principles and
*without* the diff engine, what each emitted row is required to say. Every status makes a
falsifiable claim about the source, so check the claim rather than the row:

| Status | The claim, checked against the source |
| --- | --- |
| `Added` | The key **is** in this month and **was not** in the preceding one. |
| `Removed` | The key **is not** in this month, **was** in the preceding one — and the row's values **equal that preceding month's row**. |
| `Modified` | The key is in **both** months. |
| any | The status is in the allowed vocabulary, and the month is one that exists in the workbook. |

## The bug this exists to catch

**A `Removed` row is labeled with the month the removal was observed in, but must carry the
values from the month *before* it** — the last month the row actually existed. The current month
has nothing to show for a row that is gone from it.

Get that backwards and you emit a row that is entirely plausible and entirely wrong. In the
reference sample, Bob (`102`) is `Active` in January, `Inactive` in February, and gone in March.
The correct row is:

```
Mar  102  Removed  Inactive  Bob        <- March's row, February's values
```

Flip it to carry January's values and you get `Mar 102 Removed Active Bob` — which looks fine,
and which the invariant check refuses:

```
FAIL  changes.json does not match sample.xlsx
  - row missing from the output: ('Mar', '102', 'Removed', 'Inactive', 'Bob')
  - row in the output that the diff does not produce: ('Mar', '102', 'Removed', 'Active', 'Bob')
  - Mar/102: Removed row carries Status='Active', but Feb (the month it was last seen in) says 'Inactive'
```

That third line is the invariant pass talking, and it is the one that names the actual rule. This
is the exact failure the `with_name` variant of the template was written to prevent, which is why
it gets a dedicated check rather than a comment.

## Where to run it

- **Before handing over a changes file.** One command, and you know.
- **In CI**, whenever the engine or the contract changes — a diff engine is very easy to break in
  a way that still produces output.
- **After a workbook is re-cut**, to confirm the changes file was actually regenerated and is not
  the last run's file still sitting on disk.

## What it does not check

Styling. Fill colours, column widths, the frozen header, and the `tbl_Changes` table registration
are `py-xlsx-diff-export`'s contract; this skill verifies **data**, not presentation. A file can pass
verification and still be ugly.

## Related skills

`py-xlsx-diff-commons` (the contract being verified) · `py-xlsx-month-diff` (produces the file) ·
`py-xlsx-workbook-inspect` (catches bad *input* the same way this catches bad output)
