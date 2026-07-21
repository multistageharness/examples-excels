"""Command line entry point: take an .xlsx workbook, print (or write) what changed."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Optional, Sequence

from . import __version__
from .diff import diff_tables
from .reader import DEFAULT_KEY, DEFAULT_TABLE_PREFIX, MONTHS, WorkbookError, read_workbook
from .writer import FORMATS, format_for, render, write_xlsx

EXIT_OK = 0
EXIT_ERROR = 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="xldiff",
        description=(
            "Compare the monthly tables in an Excel workbook and output only the rows "
            "that changed -- added and removed rows, with all their columns."
        ),
        epilog=(
            "The workbook should hold one table per month, either as Excel tables named "
            "tbl_Jan...tbl_Dec or as sheets named Jan...Dec. Each month is compared "
            "against the month before it."
        ),
    )
    parser.add_argument("workbook", type=Path, help="path to the .xlsx workbook to compare")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="write the result to this file (default: print to stdout)",
    )
    parser.add_argument(
        "-f",
        "--format",
        choices=FORMATS,
        help="output format (default: inferred from --output's extension, else 'table')",
    )
    parser.add_argument(
        "-k",
        "--key",
        default=DEFAULT_KEY,
        metavar="COLUMN",
        help=f"column that identifies a row across months (default: {DEFAULT_KEY})",
    )
    parser.add_argument(
        "--table-prefix",
        default=DEFAULT_TABLE_PREFIX,
        metavar="PREFIX",
        help=f"prefix of the per-month Excel table names (default: {DEFAULT_TABLE_PREFIX})",
    )
    parser.add_argument(
        "--months",
        metavar="LIST",
        help="comma-separated months, in order, to compare (default: Jan..Dec)",
    )
    parser.add_argument(
        "--detect-modified",
        action="store_true",
        help="also report rows whose key stayed but whose values changed, as 'Modified'",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="include Unchanged and Base Month rows too, instead of only the changes",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def _parse_months(raw: Optional[str]) -> List[str]:
    if not raw:
        return list(MONTHS)

    months = [month.strip() for month in raw.split(",") if month.strip()]
    unknown = [month for month in months if month not in MONTHS]
    if unknown:
        raise WorkbookError(
            f"Unknown month(s): {', '.join(unknown)}. Expected any of: {', '.join(MONTHS)}."
        )
    if len(months) < 2:
        raise WorkbookError("--months needs at least two months to have anything to compare.")
    return months


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        months = _parse_months(args.months)
        tables = read_workbook(
            args.workbook, key=args.key, table_prefix=args.table_prefix, months=months
        )
        result = diff_tables(
            tables,
            key=args.key,
            months=months,
            include_unchanged=args.all,
            detect_modified=args.detect_modified,
        )
    except WorkbookError as exc:
        print(f"xldiff: {exc}", file=sys.stderr)
        return EXIT_ERROR

    fmt = format_for(args.output, args.format)

    if fmt == "xlsx" and args.output is None:
        print("xldiff: --format xlsx needs an --output path to write to.", file=sys.stderr)
        return EXIT_ERROR

    if args.output is None:
        print(render(result, fmt))
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        if fmt == "xlsx":
            write_xlsx(result, args.output)
        else:
            args.output.write_text(render(result, fmt), encoding="utf-8")

    if args.output is not None:
        found = ", ".join(sorted(tables, key=months.index))
        print(
            f"xldiff: {len(result)} changed row(s) across {found} -> {args.output}",
            file=sys.stderr,
        )

    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
