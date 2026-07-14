# xlsx month-diff skills

Eleven agent skills that take an Excel workbook holding **one table per month**, extract **only
the rows that changed** from one month to the next, and write them to a **new file** — with no
Excel, no Office, and no Power Query in the loop.

They are a skill-shaped port of the `CompareMonths_changes_only_with_name` Power Query template.
The behavior is specified by `REQ.md` in the reference project (a sibling of this `llm/` tree),
and every rule in `py-xlsx-diff-commons/reference/CONTRACT.md` cites the requirement it implements.

**There are two complete implementations of that contract**, distinguished by prefix:

- **`py-`** — Python + openpyxl. The one to use if you can `pip install openpyxl`.
- **`bash-`** — POSIX shell + `unzip`/`sed`/`awk`/`zip`. Nothing to install. Use it on a
  locked-down runner, a minimal container, or an appliance where you cannot add packages.

They agree: **45 of 45 outputs are byte-identical**, and each one's `.xlsx` passes the *other's*
verifier. The differences are two, both real: the shell suite does not decode **dates** (they come
out as raw serial numbers) and has no **M-injection** skill. See
[`bash-xlsx-diff-commons/reference/PARITY.md`](bash-xlsx-diff-commons/reference/PARITY.md).

## The skills

| Python | Shell | Use it to |
| --- | --- | --- |
| **[py-xlsx-month-diff](py-xlsx-month-diff/SKILL.md)** | **[bash-xlsx-month-diff](bash-xlsx-month-diff/SKILL.md)** | **Start here.** Workbook in, changes file out. |
| [py-xlsx-workbook-inspect](py-xlsx-workbook-inspect/SKILL.md) | [bash-xlsx-workbook-inspect](bash-xlsx-workbook-inspect/SKILL.md) | Pre-flight: is this workbook even diffable? |
| [py-xlsx-diff-export](py-xlsx-diff-export/SKILL.md) | [bash-xlsx-diff-export](bash-xlsx-diff-export/SKILL.md) | Write the result: styled `.xlsx`, `.csv`, `.json`, table. |
| [py-xlsx-diff-verify](py-xlsx-diff-verify/SKILL.md) | [bash-xlsx-diff-verify](bash-xlsx-diff-verify/SKILL.md) | Prove the emitted file describes its source workbook. |
| [py-xlsx-diff-commons](py-xlsx-diff-commons/SKILL.md) | [bash-xlsx-diff-commons](bash-xlsx-diff-commons/SKILL.md) | The engine, the contract, the fixtures. A dependency. |
| [py-powerquery-m-diff-inject](py-powerquery-m-diff-inject/SKILL.md) | — | The Excel-native path: rewrite the embedded M query. |

Five of them are one pipeline; the sixth is the road not taken. The shell suite mirrors the first
five.

```
                   ┌──────────────────────────┐
  workbook.xlsx ──►│ py-xlsx-workbook-inspect │  diffable? gaps? dupes?
                   └────────────┬─────────────┘
                                ▼
                   ┌──────────────────────────┐
                   │     py-xlsx-month-diff   │  each month vs the one before it
                   └────────────┬─────────────┘  (engine: py-xlsx-diff-commons)
                                ▼
                   ┌──────────────────────────┐
                   │    py-xlsx-diff-export   │  ──►  changes.xlsx / .csv / .json
                   └────────────┬─────────────┘
                                ▼
                   ┌──────────────────────────┐
                   │    py-xlsx-diff-verify   │  does the file match the source?
                   └──────────────────────────┘
```

## Quick start

**Python** — `openpyxl` is the only dependency (`pip install openpyxl`). With `$WB` set to the
workbook you want to diff:

```bash
python3 py-xlsx-workbook-inspect/scripts/inspect_workbook.py "$WB"          # 1. look first
python3 py-xlsx-diff-commons/scripts/xldiff_core.py "$WB" -o changes.xlsx   # 2. diff it
python3 py-xlsx-diff-verify/scripts/verify_diff.py "$WB" changes.xlsx       # 3. trust it
```

**Shell** — nothing to install:

```bash
bash-xlsx-workbook-inspect/scripts/inspect.sh "$WB"                              # 1. look first
bash-xlsx-diff-commons/scripts/xldiff.sh "$WB" -f tsv \
  | bash-xlsx-diff-export/scripts/write_xlsx.sh changes.xlsx                     # 2. diff it
bash-xlsx-diff-verify/scripts/verify.sh "$WB" changes.xlsx                       # 3. trust it
```

Both produce the same file. Try either on the suite's fixtures, which are generated rather than
committed:

```bash
python3 py-xlsx-diff-commons/scripts/make_fixtures.py fixtures
python3 py-xlsx-diff-commons/scripts/xldiff_core.py fixtures/sample.xlsx   # or:
bash-xlsx-diff-commons/scripts/xldiff.sh          fixtures/sample.xlsx
```

```
Month  ID   Change_Status  Status    Owner
-----  ---  -------------  --------  -------
Feb    103  Removed        Active    Charlie
Feb    105  Added          Active    Eve
Mar    102  Removed        Inactive  Bob
Mar    106  Added          New       Frank
```

## The three things worth knowing

**A `Removed` row carries the *previous* month's values.** `Mar / 102 / Removed / Inactive / Bob`
means Bob vanished in March, and `Inactive` is what he was in February — the last month he
existed. The row is labeled with the month the removal was *observed* in, but the data comes from
the month it was last *seen* in, because March has nothing to show for a row that is gone from
it. Getting this backwards produces a file that looks completely fine. It is the reason
`py-xlsx-diff-verify` re-derives every row from the source instead of trusting the engine, and the
reason the template it came from is called `with_name`.

**A gap in the months produces an empty diff, not an error.** A month whose immediate predecessor
is absent is treated as a base month — the comparison short-circuits rather than reaching further
back. Jan + Mar with no Feb yields *zero changes*, silently. That is faithful to `List.Generate`
in the M template, and it is why `py-xlsx-workbook-inspect` exists.

**`Modified` is opt-in.** By default a row whose key survived but whose values changed is
`Unchanged`, and is filtered out — M-parity with the original template. Pass `--detect-modified`
to catch value changes.

## Two paths, one contract

`py-xlsx-month-diff` replaces Power Query: it reads the workbook directly and computes the diff in
Python, so it runs in CI or a cron job on a machine that has never had Office installed. It also
reads the sheet-only layout (`Jan`, `Feb`, …), which Power Query fundamentally cannot, because
`Excel.CurrentWorkbook()` only sees named tables.

`py-powerquery-m-diff-inject` keeps Power Query: it rewrites the M embedded in the workbook so the
diff stays live and refreshes when a user opens the file. Use it when the deliverable is *a
workbook someone opens*; use the other when the deliverable is *the changed rows*.

Both are judged against the same spec: `py-xlsx-diff-commons/reference/CONTRACT.md`.
