/** Reading months out of a real .xlsx: named tables, sheet fallback, and bad input. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WorkbookError, readWorkbook } from "../src/reader.js";
import { makeWorkbook, sampleWorkbook, tempDir } from "./helpers.js";

describe("reader", () => {
  it("reads named tables", async () => {
    const tables = readWorkbook(await sampleWorkbook());

    expect([...tables.keys()]).toEqual(["Jan", "Feb", "Mar"]);
    expect(tables.get("Jan")!.columns).toEqual(["ID", "Status", "Owner"]);
    expect(tables.get("Jan")!.source).toBe("table tbl_Jan");
    expect(tables.get("Feb")!.rows[0]).toEqual({ ID: 101, Status: "Active", Owner: "Alice" });
  });

  it("returns months in calendar order, not sheet order", async () => {
    const path = await makeWorkbook({ Mar: [[1, "a", "b"]], Jan: [[1, "a", "b"]] });
    expect([...readWorkbook(path).keys()]).toEqual(["Jan", "Mar"]);
  });

  it("falls back to sheets when no tables are defined", async () => {
    const path = await makeWorkbook({ Jan: [[101, "Active", "Alice"]] }, { asTables: false });

    const tables = readWorkbook(path);
    expect(tables.get("Jan")!.source).toBe("sheet Jan");
    expect(tables.get("Jan")!.rows).toEqual([{ ID: 101, Status: "Active", Owner: "Alice" }]);
  });

  it("skips blank rows and padded cells", async () => {
    const path = await makeWorkbook(
      { Jan: [[101, "Active", "Alice"], [null, null, null], [102, "Active", "Bob"]] },
      { asTables: false },
    );

    expect(readWorkbook(path).get("Jan")!.rows.map((row) => row.ID)).toEqual([101, 102]);
  });

  it("reads whitespace-only cells as empty", async () => {
    const path = await makeWorkbook({ Jan: [[101, "  ", "  Alice  "]] }, { asTables: false });

    const rows = readWorkbook(path).get("Jan")!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].Status).toBeNull();
    expect(rows[0].Owner).toBe("Alice");
  });

  it("honors a custom table prefix", async () => {
    const path = await makeWorkbook({ Jan: [[1, "a", "b"]] }, { prefix: "data_" });
    expect([...readWorkbook(path, { tablePrefix: "data_" }).keys()]).toEqual(["Jan"]);
  });

  it("reports a missing file clearly", () => {
    expect(() => readWorkbook(join(tempDir(), "nope.xlsx"))).toThrow(/No such workbook/);
  });

  it("reports a workbook with no months clearly", async () => {
    const path = await makeWorkbook({ Summary: [[1, "a", "b"]] }, { asTables: false });
    expect(() => readWorkbook(path)).toThrow(/no month tables/);
  });

  it("reports a missing key column clearly", async () => {
    const path = await makeWorkbook({ Jan: [[1, "a"]] }, {
      columns: ["Code", "Status"],
      asTables: false,
    });
    expect(() => readWorkbook(path)).toThrow(/Key column 'ID' is missing from: Jan/);
  });

  it("reports a non-xlsx file clearly", () => {
    const path = join(tempDir(), "not-a-workbook.xlsx");
    writeFileSync(path, "I am a CSV, honest");
    expect(() => readWorkbook(path)).toThrow(WorkbookError);
    expect(() => readWorkbook(path)).toThrow(/Could not open/);
  });
});
