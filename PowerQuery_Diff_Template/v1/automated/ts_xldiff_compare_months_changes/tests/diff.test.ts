/** The diff engine, exercised against in-memory month tables (no Excel involved). */

import { describe, expect, it } from "vitest";

import {
  ADDED,
  BASE_MONTH,
  MODIFIED,
  REMOVED,
  UNCHANGED,
  compareMonths,
  diffTables,
} from "../src/diff.js";
import { MonthTable, type CellValue, type Row } from "../src/reader.js";

const COLUMNS = ["ID", "Status", "Owner"];

function table(month: string, ...rows: CellValue[][]): MonthTable {
  const built: Row[] = rows.map((row) => {
    const record: Row = {};
    COLUMNS.forEach((column, i) => {
      record[column] = row[i] ?? null;
    });
    return record;
  });
  return new MonthTable(month, [...COLUMNS], built);
}

describe("diff engine", () => {
  it("treats the first month as the base month", () => {
    const changes = compareMonths(null, table("Jan", [101, "Active", "Alice"]));
    expect(changes.map((c) => [c.month, c.key, c.status])).toEqual([["Jan", 101, BASE_MONTH]]);
  });

  it("detects added and removed", () => {
    const jan = table("Jan", [101, "Active", "Alice"], [103, "Active", "Charlie"]);
    const feb = table("Feb", [101, "Active", "Alice"], [105, "Active", "Eve"]);

    const changes = Object.fromEntries(compareMonths(jan, feb).map((c) => [c.key, c.status]));
    expect(changes).toEqual({ 101: UNCHANGED, 103: REMOVED, 105: ADDED });
  });

  it("carries the previous month's values on a removed row", () => {
    const jan = table("Jan", [103, "Active", "Charlie"]);
    const feb = table("Feb");

    const removed = compareMonths(jan, feb)[0];
    expect(removed.status).toBe(REMOVED);
    expect(removed.month).toBe("Feb"); // reported against the month it vanished in
    expect(removed.values.Owner).toBe("Charlie");
    expect(removed.values.Status).toBe("Active");
  });

  it("uses the last-seen values on a removed row, not the first", () => {
    const tables = {
      Jan: table("Jan", [102, "Active", "Bob"]),
      Feb: table("Feb", [102, "Inactive", "Bob"]),
      Mar: table("Mar"),
    };

    const result = diffTables(tables);
    expect(result.changes).toHaveLength(1);
    const [removed] = result.changes;
    expect([removed.month, removed.status]).toEqual(["Mar", REMOVED]);
    expect(removed.values.Status).toBe("Inactive");
  });

  it("filters out unchanged and base-month rows by default", () => {
    const tables = {
      Jan: table("Jan", [101, "Active", "Alice"]),
      Feb: table("Feb", [101, "Active", "Alice"], [105, "Active", "Eve"]),
    };

    const result = diffTables(tables);
    expect(result.changes.map((c) => [c.month, c.key, c.status])).toEqual([["Feb", 105, ADDED]]);
  });

  it("keeps every row with includeUnchanged", () => {
    const tables = {
      Jan: table("Jan", [101, "Active", "Alice"]),
      Feb: table("Feb", [101, "Active", "Alice"]),
    };

    const statuses = diffTables(tables, "ID", undefined, true).changes.map((c) => c.status);
    expect(statuses).toEqual([BASE_MONTH, UNCHANGED]);
  });

  it("flags value changes on a surviving key with detectModified", () => {
    const tables = {
      Jan: table("Jan", [102, "Active", "Bob"]),
      Feb: table("Feb", [102, "Inactive", "Bob"]),
    };

    expect(diffTables(tables).changes).toEqual([]);

    const modified = diffTables(tables, "ID", undefined, false, true).changes;
    expect(modified).toHaveLength(1);
    expect([modified[0].key, modified[0].status]).toEqual([102, MODIFIED]);
    expect(modified[0].values.Status).toBe("Inactive"); // the new value, not the old
  });

  it("treats a month after a gap as a new base month", () => {
    const tables = {
      Jan: table("Jan", [101, "Active", "Alice"]),
      Mar: table("Mar", [999, "New", "Zoe"]),
    };

    const result = diffTables(tables, "ID", undefined, true);
    expect(result.changes.map((c) => [c.month, c.status])).toEqual([
      ["Jan", BASE_MONTH],
      ["Mar", BASE_MONTH],
    ]);
  });

  it("orders output by month then key", () => {
    const tables = {
      Jan: table("Jan", [1, "a", "x"], [2, "a", "x"]),
      Feb: table("Feb", [10, "a", "x"], [3, "a", "x"]),
    };

    const result = diffTables(tables);
    // Numeric keys sort numerically (3 before 10), removals and additions interleaved.
    expect(result.changes.map((c) => [c.key, c.status])).toEqual([
      [1, REMOVED],
      [2, REMOVED],
      [3, ADDED],
      [10, ADDED],
    ]);
  });

  it("does not blow up on mixed key types", () => {
    const tables = {
      Jan: table("Jan", ["A-2", "x", "y"]),
      Feb: table("Feb", [7, "x", "y"]),
    };

    const result = diffTables(tables);
    expect(result.changes.map((c) => c.status).sort()).toEqual([ADDED, REMOVED]);
  });

  it("puts month, key and status first in the header", () => {
    const tables = { Jan: table("Jan", [101, "Active", "Alice"]) };
    expect(diffTables(tables).header).toEqual(["Month", "ID", "Change_Status", "Status", "Owner"]);
  });

  it("supports a custom key column", () => {
    const columns = ["Email", "Plan"];
    const tables = {
      Jan: new MonthTable("Jan", columns, [{ Email: "a@x.io", Plan: "Pro" }]),
      Feb: new MonthTable("Feb", columns, [{ Email: "b@x.io", Plan: "Free" }]),
    };

    const result = diffTables(tables, "Email");
    expect(result.header).toEqual(["Month", "Email", "Change_Status", "Plan"]);
    expect(new Set(result.changes.map((c) => `${c.key}:${c.status}`))).toEqual(
      new Set([`a@x.io:${REMOVED}`, `b@x.io:${ADDED}`]),
    );
  });

  it.each([false, true])("diffs an empty workbook to nothing (includeUnchanged=%s)", (include) => {
    expect(diffTables({}, "ID", undefined, include).changes).toEqual([]);
  });
});
