#!/usr/bin/env python3
"""Probe an .xlsx workbook and report whether it can be diffed -- before trying to diff it.

    python3 inspect_workbook.py WORKBOOK [--key ID] [--table-prefix tbl_] [--json]

Exit code 0 means the workbook is diffable as configured; 1 means it is not, and the reason
is printed. Findings that are legal but worth knowing (a gap in the month sequence, duplicate
keys, null keys) are reported as warnings and do NOT fail the run.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

# The engine lives in the commons skill; this script is a reporter, not a second implementation.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "py-xlsx-diff-commons" / "scripts"))

from xldiff_core import (  # noqa: E402
    DEFAULT_KEY,
    DEFAULT_TABLE_PREFIX,
    MONTHS,
    WorkbookError,
    _read_named_tables,
    _read_sheets,
    load_workbook,
)

EXIT_OK = 0
EXIT_ERROR = 1


def inspect(path: Path, key: str, table_prefix: str) -> dict:
    """Read the workbook under BOTH layouts and describe what is actually there."""
    if not path.is_file():
        raise WorkbookError(f"No such workbook: {path}")

    try:
        workbook = load_workbook(path, data_only=True, read_only=False)
    except Exception as exc:
        raise WorkbookError(f"Could not open {path.name} as an .xlsx workbook: {exc}") from exc

    try:
        sheet_titles = [ws.title for ws in workbook.worksheets]
        table_names = sorted(
            str(t.name) for ws in workbook.worksheets for t in ws.tables.values()
        )
        by_table = _read_named_tables(workbook, table_prefix, MONTHS)
        by_sheet = _read_sheets(workbook, MONTHS)
    finally:
        workbook.close()

    # The reader prefers named tables and only falls back to sheets when NO table matched.
    layout = "named-tables" if by_table else ("sheets" if by_sheet else "none")
    tables = by_table or by_sheet

    report = {
        "workbook": str(path),
        "layout": layout,
        "key": key,
        "table_prefix": table_prefix,
        "sheet_titles": sheet_titles,
        "table_names": table_names,
        "months_found": [m for m in MONTHS if m in tables],
        "months": {},
        "errors": [],
        "warnings": [],
    }

    if not tables:
        report["errors"].append(
            f"No month tables. Expected Excel tables named '{table_prefix}Jan'..."
            f"'{table_prefix}Dec', or sheets named 'Jan'...'Dec'."
        )
        return report

    for month in report["months_found"]:
        table = tables[month]
        keys = [row.get(key) for row in table.rows]
        duplicates = sorted(
            str(k) for k, n in Counter(k for k in keys if k is not None).items() if n > 1
        )
        nulls = sum(1 for k in keys if k is None)

        report["months"][month] = {
            "source": table.source,
            "columns": table.columns,
            "rows": len(table.rows),
            "has_key": key in table.columns,
            "duplicate_keys": duplicates,
            "null_keys": nulls,
        }

        if key not in table.columns:
            report["errors"].append(
                f"{month}: key column {key!r} is missing (columns: {', '.join(table.columns)})."
            )
        if duplicates:
            report["warnings"].append(
                f"{month}: duplicate key(s) {', '.join(duplicates)} -- the last row wins."
            )
        if nulls:
            report["warnings"].append(
                f"{month}: {nulls} row(s) with a null key -- excluded from the diff."
            )

    found = report["months_found"]

    # A month whose IMMEDIATE predecessor is absent is treated as a base month: the comparison
    # short-circuits rather than reaching further back. Silently dropped rows start here.
    for month in found:
        index = MONTHS.index(month)
        if index > 0 and MONTHS[index - 1] not in tables and month != found[0]:
            report["warnings"].append(
                f"{month}: predecessor {MONTHS[index - 1]} is absent, so {month} is treated as a "
                f"base month and contributes no changes."
            )

    if len(found) < 2:
        report["warnings"].append(
            f"Only {len(found)} month(s) found -- there is nothing to compare, so the diff "
            f"will be empty."
        )

    # The union of columns across months; a column present in only one month still appears.
    union: list = []
    for month in found:
        for column in report["months"][month]["columns"]:
            if column not in union:
                union.append(column)
    report["column_union"] = union

    ragged = [
        month for month in found
        if report["months"][month]["columns"] != report["months"][found[0]]["columns"]
    ]
    if ragged:
        report["warnings"].append(
            f"Column sets differ across months ({', '.join(ragged)} vs {found[0]}); the output "
            f"carries the union and missing cells are blank."
        )

    return report


def render(report: dict) -> str:
    out = [
        f"workbook : {report['workbook']}",
        f"layout   : {report['layout']}",
        f"key      : {report['key']}",
        f"months   : {', '.join(report['months_found']) or '(none)'}",
    ]
    if report.get("column_union"):
        out.append(f"columns  : {', '.join(report['column_union'])}")
    out.append("")

    if report["months"]:
        out.append(f"{'Month':<7} {'Rows':>5}  {'Key?':<5} {'Source':<18} Columns")
        out.append(f"{'-' * 7} {'-' * 5}  {'-' * 5} {'-' * 18} {'-' * 30}")
        for month, info in report["months"].items():
            out.append(
                f"{month:<7} {info['rows']:>5}  {'yes' if info['has_key'] else 'NO':<5} "
                f"{info['source']:<18} {', '.join(info['columns'])}"
            )
        out.append("")

    for warning in report["warnings"]:
        out.append(f"warn  {warning}")
    for error in report["errors"]:
        out.append(f"ERROR {error}")

    if not report["errors"]:
        out.append("")
        out.append(f"OK: diffable ({len(report['months_found'])} month(s) found).")

    return "\n".join(out)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="inspect_workbook",
        description="Report a workbook's month layout, key column, and diffability.",
    )
    parser.add_argument("workbook", type=Path)
    parser.add_argument("-k", "--key", default=DEFAULT_KEY, metavar="COLUMN")
    parser.add_argument("--table-prefix", default=DEFAULT_TABLE_PREFIX, metavar="PREFIX")
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = parser.parse_args(argv)

    try:
        report = inspect(args.workbook, args.key, args.table_prefix)
    except WorkbookError as exc:
        print(f"inspect: {exc}", file=sys.stderr)
        return EXIT_ERROR

    print(json.dumps(report, indent=2, default=str) if args.json else render(report))
    return EXIT_ERROR if report["errors"] else EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
