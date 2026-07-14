"""The diff engine, exercised against in-memory month tables (no Excel involved)."""

from __future__ import annotations

import pytest

from xldiff.diff import ADDED, BASE_MONTH, MODIFIED, REMOVED, UNCHANGED, compare_months, diff_tables
from xldiff.reader import MonthTable

COLUMNS = ["ID", "Status", "Owner"]


def table(month: str, *rows) -> MonthTable:
    return MonthTable(month, list(COLUMNS), [dict(zip(COLUMNS, row)) for row in rows])


def test_first_month_is_the_base_month():
    changes = compare_months(None, table("Jan", (101, "Active", "Alice")))

    assert [(c.month, c.key, c.status) for c in changes] == [("Jan", 101, BASE_MONTH)]


def test_added_and_removed_are_detected():
    jan = table("Jan", (101, "Active", "Alice"), (103, "Active", "Charlie"))
    feb = table("Feb", (101, "Active", "Alice"), (105, "Active", "Eve"))

    changes = {c.key: c.status for c in compare_months(jan, feb)}

    assert changes == {101: UNCHANGED, 103: REMOVED, 105: ADDED}


def test_removed_rows_carry_the_previous_months_values():
    """The whole point of the with_name variant: a removed row still has its data."""
    jan = table("Jan", (103, "Active", "Charlie"))
    feb = table("Feb")

    removed = compare_months(jan, feb)[0]

    assert removed.status == REMOVED
    assert removed.month == "Feb"  # reported against the month it vanished in
    assert removed.values["Owner"] == "Charlie"
    assert removed.values["Status"] == "Active"


def test_removed_rows_use_the_last_seen_values_not_the_first():
    """Bob is Active in Jan, Inactive in Feb, gone in Mar -> his removal says Inactive."""
    tables = {
        "Jan": table("Jan", (102, "Active", "Bob")),
        "Feb": table("Feb", (102, "Inactive", "Bob")),
        "Mar": table("Mar"),
    }

    result = diff_tables(tables)

    (removed,) = result.changes
    assert (removed.month, removed.status) == ("Mar", REMOVED)
    assert removed.values["Status"] == "Inactive"


def test_unchanged_and_base_month_rows_are_filtered_out_by_default():
    tables = {
        "Jan": table("Jan", (101, "Active", "Alice")),
        "Feb": table("Feb", (101, "Active", "Alice"), (105, "Active", "Eve")),
    }

    result = diff_tables(tables)

    assert [(c.month, c.key, c.status) for c in result.changes] == [("Feb", 105, ADDED)]


def test_include_unchanged_keeps_every_row():
    tables = {
        "Jan": table("Jan", (101, "Active", "Alice")),
        "Feb": table("Feb", (101, "Active", "Alice")),
    }

    statuses = [c.status for c in diff_tables(tables, include_unchanged=True).changes]

    assert statuses == [BASE_MONTH, UNCHANGED]


def test_detect_modified_flags_value_changes_on_a_surviving_key():
    tables = {
        "Jan": table("Jan", (102, "Active", "Bob")),
        "Feb": table("Feb", (102, "Inactive", "Bob")),
    }

    assert diff_tables(tables).changes == []

    (modified,) = diff_tables(tables, detect_modified=True).changes
    assert (modified.key, modified.status) == (102, MODIFIED)
    assert modified.values["Status"] == "Inactive"  # the new value, not the old


def test_a_month_after_a_gap_is_treated_as_a_new_base_month():
    """List.Generate carries a null Prev forward; a gap resets the comparison."""
    tables = {
        "Jan": table("Jan", (101, "Active", "Alice")),
        "Mar": table("Mar", (999, "New", "Zoe")),
    }

    result = diff_tables(tables, include_unchanged=True)

    assert [(c.month, c.status) for c in result.changes] == [
        ("Jan", BASE_MONTH),
        ("Mar", BASE_MONTH),
    ]


def test_output_is_ordered_by_month_then_key():
    tables = {
        "Jan": table("Jan", (1, "a", "x"), (2, "a", "x")),
        "Feb": table("Feb", (10, "a", "x"), (3, "a", "x")),
    }

    result = diff_tables(tables)

    # Numeric keys sort numerically (3 before 10), removals and additions interleaved.
    assert [(c.key, c.status) for c in result.changes] == [
        (1, REMOVED),
        (2, REMOVED),
        (3, ADDED),
        (10, ADDED),
    ]


def test_mixed_key_types_do_not_blow_up():
    tables = {
        "Jan": table("Jan", ("A-2", "x", "y")),
        "Feb": table("Feb", (7, "x", "y")),
    }

    result = diff_tables(tables)

    assert sorted(c.status for c in result.changes) == [ADDED, REMOVED]


def test_header_puts_month_key_and_status_first():
    tables = {"Jan": table("Jan", (101, "Active", "Alice"))}

    assert diff_tables(tables).header == ["Month", "ID", "Change_Status", "Status", "Owner"]


def test_a_custom_key_column_can_be_used():
    columns = ["Email", "Plan"]
    tables = {
        "Jan": MonthTable("Jan", columns, [{"Email": "a@x.io", "Plan": "Pro"}]),
        "Feb": MonthTable("Feb", columns, [{"Email": "b@x.io", "Plan": "Free"}]),
    }

    result = diff_tables(tables, key="Email")

    assert result.header == ["Month", "Email", "Change_Status", "Plan"]
    assert {(c.key, c.status) for c in result.changes} == {
        ("a@x.io", REMOVED),
        ("b@x.io", ADDED),
    }


@pytest.mark.parametrize("include_unchanged", [False, True])
def test_an_empty_workbook_diffs_to_nothing(include_unchanged):
    assert diff_tables({}, include_unchanged=include_unchanged).changes == []
