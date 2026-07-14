#!/usr/bin/env python3
"""Check that an emitted diff file actually describes the workbook it claims to.

    python3 verify_diff.py SOURCE.xlsx CHANGES.xlsx [--key ID] [--detect-modified] [--all]

SOURCE is the workbook that was diffed; CHANGES is the .xlsx/.csv/.json the diff was written
to. Exit 0 = every check passed, 1 = at least one failed.

Two independent kinds of check, and the distinction matters:

  PARITY   re-run the engine over SOURCE and compare to CHANGES row for row. This catches a
           stale, truncated, hand-edited, or wrong-workbook output file. It does NOT catch an
           engine bug -- it is comparing the engine against itself.

  INVARIANT go back to SOURCE's raw month tables and re-derive, from first principles and
           without the diff engine, what each emitted row is required to say. This is what
           catches an engine bug, and it is where the interesting rule lives:

             a Removed row is LABELED with the month the removal was observed in, but CARRIES
             the values from the month BEFORE it -- the last month the row actually existed.

           Getting that backwards still produces a plausible-looking file, and parity alone
           would happily bless it. The invariant check is what refuses to.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "py-xlsx-diff-commons" / "scripts"))

from xldiff_core import (  # noqa: E402
    ADDED,
    BASE_MONTH,
    CHANGE_STATUSES,
    DEFAULT_KEY,
    DEFAULT_TABLE_PREFIX,
    MODIFIED,
    MONTH_COLUMN,
    MONTHS,
    REMOVED,
    STATUS_COLUMN,
    UNCHANGED,
    WorkbookError,
    _text,
    diff_tables,
    load_workbook,
    read_workbook,
)

EXIT_OK = 0
EXIT_ERROR = 1


def load_emitted(path: Path) -> List[Dict[str, Any]]:
    """Read back whatever we wrote, in whatever format we wrote it."""
    suffix = path.suffix.casefold()

    if suffix == ".json":
        return json.loads(path.read_text("utf-8"))

    if suffix in (".csv", ".txt"):
        with path.open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))

    if suffix in (".xlsx", ".xlsm"):
        workbook = load_workbook(path, data_only=True)
        try:
            worksheet = workbook["Changes"] if "Changes" in workbook.sheetnames else workbook.active
            grid = [list(row) for row in worksheet.iter_rows(values_only=True)]
        finally:
            workbook.close()
        if not grid:
            return []
        header = [str(cell) for cell in grid[0]]
        return [dict(zip(header, row)) for row in grid[1:]]

    raise WorkbookError(f"Don't know how to read {path.name} back; expected .xlsx/.csv/.json.")


def _row_signature(row: Dict[str, Any], header: List[str]) -> tuple:
    """Compare on rendered text: CSV and JSON round-trips lose the original Excel types."""
    return tuple(_text(row.get(column)) for column in header)


def verify(
    source: Path,
    emitted: Path,
    key: str,
    table_prefix: str,
    detect_modified: bool,
    include_unchanged: bool,
) -> List[str]:
    """Return a list of failure messages; empty means everything checked out."""
    failures: List[str] = []

    tables = read_workbook(source, key=key, table_prefix=table_prefix)
    expected = diff_tables(
        tables,
        key=key,
        include_unchanged=include_unchanged,
        detect_modified=detect_modified,
    )
    actual = load_emitted(emitted)

    header = expected.header

    # --- PARITY -------------------------------------------------------------------------
    if actual:
        got_header = list(actual[0].keys())
        if got_header != header:
            failures.append(
                f"header mismatch:\n  expected {header}\n  got      {got_header}"
            )

    if len(actual) != len(expected):
        failures.append(f"row count: expected {len(expected)}, got {len(actual)}")

    want = sorted(_row_signature(row, header) for row in expected.as_dicts())
    have = sorted(_row_signature(row, header) for row in actual)

    if want != have:
        missing = [row for row in want if row not in have]
        extra = [row for row in have if row not in want]
        for row in missing[:5]:
            failures.append(f"row missing from the output: {row}")
        for row in extra[:5]:
            failures.append(f"row in the output that the diff does not produce: {row}")

    # --- INVARIANTS ---------------------------------------------------------------------
    allowed = set(CHANGE_STATUSES) | ({UNCHANGED, BASE_MONTH} if include_unchanged else set())
    if not detect_modified:
        allowed.discard(MODIFIED)

    months_found = [month for month in MONTHS if month in tables]

    for row in actual:
        month = _text(row.get(MONTH_COLUMN))
        status = _text(row.get(STATUS_COLUMN))
        row_key = _text(row.get(key))

        if status not in allowed:
            failures.append(f"{month}/{row_key}: status {status!r} is not one of {sorted(allowed)}")
            continue

        if month not in months_found:
            failures.append(f"{month}/{row_key}: labeled with a month that is not in the workbook")
            continue

        index = MONTHS.index(month)
        previous = tables.get(MONTHS[index - 1]) if index > 0 else None
        current = tables[month]

        current_keys = {_text(k) for k in current.by_key(key)}
        previous_keys = {_text(k) for k in previous.by_key(key)} if previous else set()

        # Each status makes a falsifiable claim about the source. Check the claim, not the row.
        if status == ADDED:
            if row_key not in current_keys:
                failures.append(f"{month}/{row_key}: Added, but the key is not in {month}")
            if row_key in previous_keys:
                failures.append(
                    f"{month}/{row_key}: Added, but the key was already in {MONTHS[index - 1]}"
                )

        elif status == REMOVED:
            if row_key in current_keys:
                failures.append(f"{month}/{row_key}: Removed, but the key is still in {month}")
            if previous is None or row_key not in previous_keys:
                failures.append(
                    f"{month}/{row_key}: Removed, but the key was not in the preceding month either"
                )
                continue

            # THE RULE: a Removed row's values come from the PREVIOUS month, not the current one.
            source_row = {_text(k): v for k, v in previous.by_key(key).items()}[row_key]
            for column in expected.columns:
                want_value = _text(source_row.get(column))
                got_value = _text(row.get(column))
                if want_value != got_value:
                    failures.append(
                        f"{month}/{row_key}: Removed row carries {column}={got_value!r}, but "
                        f"{MONTHS[index - 1]} (the month it was last seen in) says {want_value!r}"
                    )

        elif status == MODIFIED:
            if row_key not in current_keys or row_key not in previous_keys:
                failures.append(f"{month}/{row_key}: Modified, but the key is not in both months")

    return failures


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="verify_diff",
        description="Verify an emitted diff file against the workbook it was derived from.",
    )
    parser.add_argument("source", type=Path, help="the workbook that was diffed")
    parser.add_argument("emitted", type=Path, help="the .xlsx/.csv/.json the diff was written to")
    parser.add_argument("-k", "--key", default=DEFAULT_KEY, metavar="COLUMN")
    parser.add_argument("--table-prefix", default=DEFAULT_TABLE_PREFIX, metavar="PREFIX")
    parser.add_argument("--detect-modified", action="store_true",
                        help="the diff was produced with --detect-modified")
    parser.add_argument("--all", action="store_true",
                        help="the diff was produced with --all")
    args = parser.parse_args(argv)

    try:
        failures = verify(
            args.source,
            args.emitted,
            args.key,
            args.table_prefix,
            args.detect_modified,
            args.all,
        )
    except (WorkbookError, OSError) as exc:
        print(f"verify: {exc}", file=sys.stderr)
        return EXIT_ERROR

    if failures:
        print(f"FAIL  {args.emitted} does not match {args.source}", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return EXIT_ERROR

    print(f"PASS  {args.emitted} matches {args.source}")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
