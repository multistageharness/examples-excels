"""Reading months out of a real .xlsx: named tables, sheet fallback, and bad input."""

from __future__ import annotations

import pytest

from py_xldiff_compare_months_changes.reader import WorkbookError, read_workbook


def test_reads_named_tables(sample_workbook):
    tables = read_workbook(sample_workbook)

    assert list(tables) == ["Jan", "Feb", "Mar"]
    assert tables["Jan"].columns == ["ID", "Status", "Owner"]
    assert tables["Jan"].source == "table tbl_Jan"
    assert tables["Feb"].rows[0] == {"ID": 101, "Status": "Active", "Owner": "Alice"}


def test_months_come_back_in_calendar_order_not_sheet_order(make_workbook):
    path = make_workbook({"Mar": [[1, "a", "b"]], "Jan": [[1, "a", "b"]]})

    assert list(read_workbook(path)) == ["Jan", "Mar"]


def test_falls_back_to_sheets_when_no_tables_are_defined(make_workbook):
    path = make_workbook({"Jan": [[101, "Active", "Alice"]]}, as_tables=False)

    tables = read_workbook(path)

    assert tables["Jan"].source == "sheet Jan"
    assert tables["Jan"].rows == [{"ID": 101, "Status": "Active", "Owner": "Alice"}]


def test_blank_rows_and_padded_cells_are_skipped(make_workbook):
    path = make_workbook(
        {"Jan": [[101, "Active", "Alice"], [None, None, None], [102, "Active", "Bob"]]},
        as_tables=False,
    )

    assert [row["ID"] for row in read_workbook(path)["Jan"].rows] == [101, 102]


def test_whitespace_only_cells_read_as_empty(make_workbook):
    path = make_workbook({"Jan": [[101, "  ", "  Alice  "]]}, as_tables=False)

    (row,) = read_workbook(path)["Jan"].rows
    assert row["Status"] is None
    assert row["Owner"] == "Alice"


def test_a_custom_table_prefix_is_honored(make_workbook):
    path = make_workbook({"Jan": [[1, "a", "b"]]}, prefix="data_")

    assert list(read_workbook(path, table_prefix="data_")) == ["Jan"]


def test_a_missing_file_is_reported_clearly(tmp_path):
    with pytest.raises(WorkbookError, match="No such workbook"):
        read_workbook(tmp_path / "nope.xlsx")


def test_a_workbook_with_no_months_is_reported_clearly(make_workbook):
    path = make_workbook({"Summary": [[1, "a", "b"]]}, as_tables=False)

    with pytest.raises(WorkbookError, match="no month tables"):
        read_workbook(path)


def test_a_missing_key_column_is_reported_clearly(make_workbook):
    path = make_workbook({"Jan": [[1, "a"]]}, columns=("Code", "Status"), as_tables=False)

    with pytest.raises(WorkbookError, match="Key column 'ID' is missing from: Jan"):
        read_workbook(path)


def test_a_non_xlsx_file_is_reported_clearly(tmp_path):
    path = tmp_path / "not-a-workbook.xlsx"
    path.write_text("I am a CSV, honest")

    with pytest.raises(WorkbookError, match="Could not open"):
        read_workbook(path)
