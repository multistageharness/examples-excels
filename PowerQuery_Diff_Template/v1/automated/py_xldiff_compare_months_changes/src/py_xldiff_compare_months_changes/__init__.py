"""Compare monthly tables in an Excel workbook and emit only the rows that changed.

A native Python port of the ``CompareMonths_changes_only_with_name`` Power Query (M)
template: it walks the twelve months in chronological order, full-outer-joins each
month against the one before it on a key column, and reports the rows that were
``Added`` or ``Removed`` -- carrying every column along, with removed rows populated
from the month they disappeared from.
"""

from .diff import (
    ADDED,
    BASE_MONTH,
    MODIFIED,
    REMOVED,
    UNCHANGED,
    ChangeRow,
    DiffResult,
    compare_months,
    diff_tables,
)
from .reader import MONTHS, MonthTable, WorkbookError, read_workbook

__version__ = "1.0.0"

__all__ = [
    "ADDED",
    "BASE_MONTH",
    "MODIFIED",
    "MONTHS",
    "REMOVED",
    "UNCHANGED",
    "ChangeRow",
    "DiffResult",
    "MonthTable",
    "WorkbookError",
    "compare_months",
    "diff_tables",
    "read_workbook",
    "__version__",
]
