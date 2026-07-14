"""The diff engine: compare each month against the one before it.

This is a direct port of the M code in ``CompareMonths_changes_only_with_name.query``:

* Each month is full-outer-joined to the previous month on the key column.
* A row whose key is absent from the previous month is ``Added``; a row whose key is
  absent from the current month is ``Removed``; a key in both is ``Unchanged``.
* ``Removed`` rows carry the values from the *previous* month -- the month they were
  last seen in -- because the current month has nothing to show for them.
* The first month present (and any month whose predecessor is missing) is the
  ``Base Month``: there is nothing to compare it against.

``Unchanged`` and ``Base Month`` rows are filtered out unless the caller asks for them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .reader import DEFAULT_KEY, MONTHS, MonthTable

ADDED = "Added"
REMOVED = "Removed"
UNCHANGED = "Unchanged"
MODIFIED = "Modified"
BASE_MONTH = "Base Month"

MONTH_COLUMN = "Month"
STATUS_COLUMN = "Change_Status"

#: The statuses that represent an actual change to the roster of rows.
CHANGE_STATUSES = (ADDED, REMOVED, MODIFIED)


@dataclass
class ChangeRow:
    """One output row: a key, what happened to it, and the data that goes with it."""

    month: str
    key: Any
    status: str
    values: Dict[str, Any]

    def as_dict(self, key_column: str, columns: Sequence[str]) -> Dict[str, Any]:
        """Flatten to the output shape: Month, <key>, Change_Status, then the rest."""
        row: Dict[str, Any] = {
            MONTH_COLUMN: self.month,
            key_column: self.key,
            STATUS_COLUMN: self.status,
        }
        for column in columns:
            row[column] = self.values.get(column)
        return row


@dataclass
class DiffResult:
    """The full diff: the output column order plus the rows, ready to write."""

    key_column: str
    columns: List[str]
    changes: List[ChangeRow]

    @property
    def header(self) -> List[str]:
        return [MONTH_COLUMN, self.key_column, STATUS_COLUMN, *self.columns]

    def as_dicts(self) -> List[Dict[str, Any]]:
        return [change.as_dict(self.key_column, self.columns) for change in self.changes]

    def __len__(self) -> int:
        return len(self.changes)


def _sort_key(value: Any) -> "tuple[int, float, str]":
    """Order keys the way a person reads them: numbers first and numerically, then text.

    Excel hands us ints, floats, strings and blanks in the same column, and those are not
    mutually comparable in Python 3 -- hence the explicit rank.
    """
    if value is None:
        return (2, 0.0, "")
    if isinstance(value, bool):
        return (1, 0.0, str(value).casefold())
    if isinstance(value, (int, float)):
        return (0, float(value), "")
    text = str(value)
    try:
        return (0, float(text), "")
    except ValueError:
        return (1, 0.0, text.casefold())


def compare_months(
    previous: Optional[MonthTable],
    current: MonthTable,
    key: str = DEFAULT_KEY,
    detect_modified: bool = False,
) -> List[ChangeRow]:
    """Compare one month against its predecessor. ``previous=None`` means base month."""
    if previous is None:
        return [
            ChangeRow(current.month, row[key], BASE_MONTH, row)
            for row in current.rows
            if row.get(key) is not None
        ]

    current_rows = current.by_key(key)
    previous_rows = previous.by_key(key)

    changes: List[ChangeRow] = []

    for row_key, row in current_rows.items():
        if row_key not in previous_rows:
            changes.append(ChangeRow(current.month, row_key, ADDED, row))
            continue

        status = UNCHANGED
        if detect_modified and _values_differ(previous_rows[row_key], row, current.columns, key):
            status = MODIFIED
        changes.append(ChangeRow(current.month, row_key, status, row))

    # Removed rows only exist in the previous month, so that is where their values come from.
    for row_key, row in previous_rows.items():
        if row_key not in current_rows:
            changes.append(ChangeRow(current.month, row_key, REMOVED, row))

    changes.sort(key=lambda change: _sort_key(change.key))
    return changes


def _values_differ(
    previous: Mapping[str, Any],
    current: Mapping[str, Any],
    columns: Sequence[str],
    key: str,
) -> bool:
    return any(
        previous.get(column) != current.get(column) for column in columns if column != key
    )


def diff_tables(
    tables: Mapping[str, MonthTable],
    key: str = DEFAULT_KEY,
    months: Optional[Sequence[str]] = None,
    include_unchanged: bool = False,
    detect_modified: bool = False,
) -> DiffResult:
    """Walk the months in order and collect every change.

    A month whose immediate predecessor is absent from the workbook is treated as a base
    month, exactly as ``List.Generate`` does in the M template: it carries ``Prev`` forward
    as null and the comparison short-circuits.
    """
    months = list(months) if months else MONTHS

    changes: List[ChangeRow] = []
    columns: List[str] = []
    seen_columns = set()

    for index, month in enumerate(months):
        current = tables.get(month)
        if current is None:
            continue

        previous = tables.get(months[index - 1]) if index > 0 else None
        changes.extend(compare_months(previous, current, key, detect_modified))

        for column in current.columns:
            if column != key and column not in seen_columns:
                seen_columns.add(column)
                columns.append(column)

    if not include_unchanged:
        changes = [change for change in changes if change.status in CHANGE_STATUSES]

    return DiffResult(key_column=key, columns=columns, changes=changes)
