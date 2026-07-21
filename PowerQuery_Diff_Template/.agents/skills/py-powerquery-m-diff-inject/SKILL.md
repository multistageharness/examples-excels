---
name: py-powerquery-m-diff-inject
description: Read or rewrite the Power Query M code embedded inside an .xlsx workbook, so the month-diff stays live and refreshable inside Excel instead of being replaced by an external tool. Documents the real on-disk DataMashup format (UTF-16 customXml → base64 → length-prefixed blob → nested ZIP → Formulas/Section1.m), which is NOT the "base64'd UTF-16LE M string" that naive guides assume, and the openpyxl trap that silently deletes the entire query on save. Use when injecting or generating M code dynamically, when a Power Query workbook lost its query after being written by a script, when inspecting what M a workbook actually contains, or when deciding between the Excel-native path and the external xldiff path.
license: MIT
compatibility: Python >= 3.9, standard library only (zipfile/base64/re). openpyxl NOT required — and must not be used on the template. Validating that Excel opens the result requires Excel.
metadata:
  role: excel-native
---

# py-powerquery-m-diff-inject

The Excel-native path. `py-xlsx-month-diff` *replaces* Power Query with a Python engine; this skill
*keeps* Power Query and rewrites the query in place, so the workbook still refreshes when a user
opens it and adds next month's table.

```bash
python3 scripts/inject_m.py TEMPLATE.xlsx --print-m                  # what query is in there?
python3 scripts/inject_m.py TEMPLATE.xlsx --m-code q.m -o OUT.xlsx   # replace it
python3 scripts/inject_m.py TEMPLATE.xlsx --m-code -  -o OUT.xlsx    # ...M from stdin
```

Every part of the workbook ZIP is copied to the output byte-for-byte except the single part that
carries the query, so nothing else in the file can be disturbed. After writing, the M is read
back out of the new file and compared — an injection that did not survive the round-trip is a
corrupt workbook, and it is better to hear that from this script than from Excel.

## Where the M code actually lives

Verified against a real Excel-authored workbook. It is nested four layers deep, and only the
outermost layer is what you would guess:

```
workbook.xlsx                     a ZIP
  customXml/item1.xml             UTF-16-encoded XML          <-- not UTF-8
    <DataMashup>…</DataMashup>    base64
      uint32 version              little-endian
      uint32 package_length       little-endian
      package                     ANOTHER ZIP, package_length bytes
        Formulas/Section1.m       the M code, as plain UTF-8 text
      permissions, metadata, bindings follow the package
```

Two consequences that trip up every naive attempt:

**The M code is not a base64'd UTF-16LE string.** It is a UTF-8 file inside a ZIP inside a
length-prefixed binary blob inside base64 inside UTF-16 XML. A heuristic that base64-decodes the
`<DataMashup>` node and looks for `let` in a UTF-16LE decoding of it will not find anything —
what it decoded is a ZIP header. Guides that describe the payload as "base64-encoded M, usually
UTF-16LE" are describing something that is not there.

**The length prefix has to be recomputed.** The 4 bytes before the package declare its length. If
you rewrite `Section1.m` the package's size changes, so copying that prefix forward yields a blob
whose declared length disagrees with reality — and Excel reports a corrupt file. This script
recomputes it and preserves the trailing permissions/metadata/bindings verbatim.

Also: the part is not always `item1.xml`. This script searches `customXml/` for the one that
actually contains a `<DataMashup>` node.

## The openpyxl trap

**openpyxl silently destroys the Power Query.** It does not preserve parts it does not model, so
a bare `load_workbook(f)` → `wb.save(f)` on a query-bearing workbook drops all of:

```
customXml/item1.xml            <-- the entire query
customXml/itemProps1.xml
customXml/_rels/item1.xml.rels
xl/connections.xml
xl/queryTables/queryTable1.xml
```

This is measured, not theoretical — a round-trip through openpyxl removes those five parts.

So the common recipe *"modify the sheets with openpyxl, then unzip the result and inject your M
into its `customXml/`"* **cannot work**: by the time you go looking, openpyxl has already deleted
the `customXml/` directory you were going to inject into. Recipes that fail this way tend to
report it as a mysterious "customXml directory not found" error, which reads like a missing
template rather than the script having deleted it a step earlier.

**Do this instead.** Keep the template as the carrier and never save it with openpyxl:

- Put the data in the **template's own month tables** and inject the M into the template
  directly. The script rewrites one part and copies the rest, so the query survives.
- Or skip Excel entirely and use `py-xlsx-month-diff`, which computes the diff itself and does not
  need a query in the file at all.

## You must start from a template

Excel rejects a `customXml` tree built from scratch — it will call the workbook corrupt. Start
from an `.xlsx` that already contains *some* Power Query (make one in Excel once: any query, even
a trivial one), and rewrite it. The script refuses to run on a workbook with no `<DataMashup>`
part rather than producing a file that Excel will reject:

```
inject_m: No <DataMashup> part found. You must start from a template workbook that already
has a Power Query in it -- Excel rejects a customXml tree built from scratch.
```

## When to use this instead of py-xlsx-month-diff

| | This skill | `py-xlsx-month-diff` |
| --- | --- | --- |
| Diff runs | In Excel, on refresh | In Python, ahead of time |
| Needs Excel to produce a result | Yes | No — runs in CI or cron |
| Workbook stays live for the user | Yes | No, the output is a static file |
| Needs a query-bearing template | Yes | No |
| Can read the sheet-only layout | No — `Excel.CurrentWorkbook()` sees named tables only | Yes |

Reach for this one when the deliverable is *a workbook a person opens and refreshes*. Reach for
`py-xlsx-month-diff` when the deliverable is *the changed rows*.

## Verification honesty

The script verifies that the M it injected reads back out of the new file identically and that
every other ZIP part is preserved byte-for-byte. It **cannot** verify that Excel opens the result
happily — that requires Excel, which the rest of this suite is specifically designed not to need.
Open the output once by hand before relying on it in a pipeline.

## Related skills

`py-xlsx-month-diff` (the no-Excel alternative) · `py-xlsx-diff-commons` (the diff rules the M code is
supposed to implement — `reference/CONTRACT.md` is the spec either path is judged against)
