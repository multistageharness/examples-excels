"""End-to-end: the CLI on a real workbook, in every output format."""

from __future__ import annotations

import json

import pytest
from openpyxl import load_workbook

from py_xldiff_compare_months_changes.cli import main

#: The exact output of the reference Power Query, as shown in the template's screenshot.
EXPECTED = [
    {"Month": "Feb", "ID": 103, "Change_Status": "Removed", "Status": "Active", "Owner": "Charlie"},
    {"Month": "Feb", "ID": 105, "Change_Status": "Added", "Status": "Active", "Owner": "Eve"},
    {"Month": "Mar", "ID": 102, "Change_Status": "Removed", "Status": "Inactive", "Owner": "Bob"},
    {"Month": "Mar", "ID": 106, "Change_Status": "Added", "Status": "New", "Owner": "Frank"},
]


def test_default_output_matches_the_power_query_reference(sample_workbook, capsys):
    exit_code = main([str(sample_workbook)])

    assert exit_code == 0
    lines = capsys.readouterr().out.strip().splitlines()
    assert lines[0].split() == ["Month", "ID", "Change_Status", "Status", "Owner"]
    assert [line.split() for line in lines[2:]] == [
        ["Feb", "103", "Removed", "Active", "Charlie"],
        ["Feb", "105", "Added", "Active", "Eve"],
        ["Mar", "102", "Removed", "Inactive", "Bob"],
        ["Mar", "106", "Added", "New", "Frank"],
    ]


def test_json_output_matches_the_power_query_reference(sample_workbook, tmp_path):
    out = tmp_path / "changes.json"

    assert main([str(sample_workbook), "-o", str(out)]) == 0
    assert json.loads(out.read_text()) == EXPECTED


def test_csv_output(sample_workbook, tmp_path):
    out = tmp_path / "changes.csv"

    assert main([str(sample_workbook), "-o", str(out)]) == 0

    lines = out.read_text().strip().splitlines()
    assert lines[0] == "Month,ID,Change_Status,Status,Owner"
    assert lines[1] == "Feb,103,Removed,Active,Charlie"
    assert len(lines) == 5


def test_xlsx_output_is_a_readable_workbook(sample_workbook, tmp_path):
    out = tmp_path / "changes.xlsx"

    assert main([str(sample_workbook), "-o", str(out)]) == 0

    worksheet = load_workbook(out).active
    rows = list(worksheet.values)
    assert rows[0] == ("Month", "ID", "Change_Status", "Status", "Owner")
    assert rows[1] == ("Feb", 103, "Removed", "Active", "Charlie")
    assert len(rows) == 5


def test_format_flag_overrides_the_extension(sample_workbook, tmp_path):
    out = tmp_path / "changes.dat"

    assert main([str(sample_workbook), "-o", str(out), "--format", "json"]) == 0
    assert json.loads(out.read_text()) == EXPECTED


@pytest.mark.parametrize("name", ["changes.csv", "changes.json", "changes.xlsx"])
def test_output_directories_are_created(sample_workbook, tmp_path, name):
    out = tmp_path / "nested" / "deeper" / name

    assert main([str(sample_workbook), "-o", str(out)]) == 0
    assert out.is_file()


def test_all_flag_includes_unchanged_and_base_rows(sample_workbook, capsys):
    assert main([str(sample_workbook), "--all"]) == 0

    out = capsys.readouterr().out
    assert "Base Month" in out
    assert "Unchanged" in out


def test_detect_modified_reports_value_changes(sample_workbook, tmp_path):
    out = tmp_path / "changes.json"

    assert main([str(sample_workbook), "--detect-modified", "-o", str(out)]) == 0

    modified = [row for row in json.loads(out.read_text()) if row["Change_Status"] == "Modified"]
    assert [(row["Month"], row["ID"], row["Status"]) for row in modified] == [
        ("Feb", 102, "Inactive"),  # Bob flipped Active -> Inactive
        ("Mar", 104, "Pending"),  # Dana flipped Active -> Pending
    ]


def test_months_flag_narrows_the_comparison(sample_workbook, tmp_path):
    out = tmp_path / "changes.json"

    assert main([str(sample_workbook), "--months", "Feb,Mar", "-o", str(out)]) == 0

    # Feb is now the base month, so only Mar's changes survive.
    assert [(row["Month"], row["ID"]) for row in json.loads(out.read_text())] == [
        ("Mar", 102),
        ("Mar", 106),
    ]


def test_xlsx_format_without_an_output_path_fails(sample_workbook, capsys):
    assert main([str(sample_workbook), "--format", "xlsx"]) == 1
    assert "needs an --output path" in capsys.readouterr().err


def test_a_missing_workbook_exits_nonzero(tmp_path, capsys):
    assert main([str(tmp_path / "nope.xlsx")]) == 1
    assert "No such workbook" in capsys.readouterr().err


def test_an_unknown_month_exits_nonzero(sample_workbook, capsys):
    assert main([str(sample_workbook), "--months", "Jan,Smarch"]) == 1
    assert "Unknown month(s): Smarch" in capsys.readouterr().err


def test_a_bad_key_column_exits_nonzero(sample_workbook, capsys):
    assert main([str(sample_workbook), "--key", "Nope"]) == 1
    assert "Key column 'Nope' is missing" in capsys.readouterr().err


@pytest.mark.parametrize("flag", ["--help", "--version"])
def test_help_and_version_exit_cleanly(flag, capsys):
    with pytest.raises(SystemExit) as exc:
        main([flag])
    assert exc.value.code == 0
