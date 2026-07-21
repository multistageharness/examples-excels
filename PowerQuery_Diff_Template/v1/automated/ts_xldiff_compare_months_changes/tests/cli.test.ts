/** End-to-end: the CLI on a real workbook, in every output format. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { gridFromUsedRange, readXlsx } from "../src/xlsx.js";
import { sampleWorkbook, tempDir } from "./helpers.js";

/** The exact output of the reference Power Query, as shown in the template's screenshot. */
const EXPECTED = [
  { Month: "Feb", ID: 103, Change_Status: "Removed", Status: "Active", Owner: "Charlie" },
  { Month: "Feb", ID: 105, Change_Status: "Added", Status: "Active", Owner: "Eve" },
  { Month: "Mar", ID: 102, Change_Status: "Removed", Status: "Inactive", Owner: "Bob" },
  { Month: "Mar", ID: 106, Change_Status: "Added", Status: "New", Owner: "Frank" },
];

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

interface Captured {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI capturing stdout, stderr, and the exit code (including process.exit). */
async function runCli(argv: string[]): Promise<Captured> {
  let out = "";
  let err = "";
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    out += chunk;
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    err += chunk;
    return true;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);

  let code: number;
  try {
    code = await main(argv);
  } catch (exc) {
    if (exc instanceof ExitSignal) {
      code = exc.code;
    } else {
      throw exc;
    }
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { code, out, err };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cli", () => {
  it("default output matches the Power Query reference", async () => {
    const { code, out } = await runCli([await sampleWorkbook()]);

    expect(code).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines[0].split(/\s+/)).toEqual(["Month", "ID", "Change_Status", "Status", "Owner"]);
    expect(lines.slice(2).map((line) => line.split(/\s+/))).toEqual([
      ["Feb", "103", "Removed", "Active", "Charlie"],
      ["Feb", "105", "Added", "Active", "Eve"],
      ["Mar", "102", "Removed", "Inactive", "Bob"],
      ["Mar", "106", "Added", "New", "Frank"],
    ]);
  });

  it("json output matches the Power Query reference", async () => {
    const out = join(tempDir(), "changes.json");
    const { code } = await runCli([await sampleWorkbook(), "-o", out]);

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual(EXPECTED);
  });

  it("csv output", async () => {
    const out = join(tempDir(), "changes.csv");
    const { code } = await runCli([await sampleWorkbook(), "-o", out]);

    expect(code).toBe(0);
    const lines = readFileSync(out, "utf-8").trim().split(/\r?\n/);
    expect(lines[0]).toBe("Month,ID,Change_Status,Status,Owner");
    expect(lines[1]).toBe("Feb,103,Removed,Active,Charlie");
    expect(lines).toHaveLength(5);
  });

  it("xlsx output is a readable workbook", async () => {
    const out = join(tempDir(), "changes.xlsx");
    const { code } = await runCli([await sampleWorkbook(), "-o", out]);

    expect(code).toBe(0);
    const workbook = readXlsx(out);
    const changes = workbook.sheets.find((sheet) => sheet.name === "Changes")!;
    const grid = gridFromUsedRange(changes);
    expect(grid[0]).toEqual(["Month", "ID", "Change_Status", "Status", "Owner"]);
    expect(grid[1]).toEqual(["Feb", 103, "Removed", "Active", "Charlie"]);
    expect(grid).toHaveLength(5);
  });

  it("the --format flag overrides the extension", async () => {
    const out = join(tempDir(), "changes.dat");
    const { code } = await runCli([await sampleWorkbook(), "-o", out, "--format", "json"]);

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual(EXPECTED);
  });

  it.each(["changes.csv", "changes.json", "changes.xlsx"])(
    "creates output directories (%s)",
    async (name) => {
      const out = join(tempDir(), "nested", "deeper", name);
      const { code } = await runCli([await sampleWorkbook(), "-o", out]);

      expect(code).toBe(0);
      expect(readFileSync(out)).toBeTruthy();
    },
  );

  it("the --all flag includes unchanged and base rows", async () => {
    const { code, out } = await runCli([await sampleWorkbook(), "--all"]);

    expect(code).toBe(0);
    expect(out).toContain("Base Month");
    expect(out).toContain("Unchanged");
  });

  it("--detect-modified reports value changes", async () => {
    const out = join(tempDir(), "changes.json");
    const { code } = await runCli([await sampleWorkbook(), "--detect-modified", "-o", out]);

    expect(code).toBe(0);
    const modified = JSON.parse(readFileSync(out, "utf-8")).filter(
      (row: any) => row.Change_Status === "Modified",
    );
    expect(modified.map((row: any) => [row.Month, row.ID, row.Status])).toEqual([
      ["Feb", 102, "Inactive"], // Bob flipped Active -> Inactive
      ["Mar", 104, "Pending"], // Dana flipped Active -> Pending
    ]);
  });

  it("--months narrows the comparison", async () => {
    const out = join(tempDir(), "changes.json");
    const { code } = await runCli([await sampleWorkbook(), "--months", "Feb,Mar", "-o", out]);

    expect(code).toBe(0);
    // Feb is now the base month, so only Mar's changes survive.
    expect(JSON.parse(readFileSync(out, "utf-8")).map((row: any) => [row.Month, row.ID])).toEqual([
      ["Mar", 102],
      ["Mar", 106],
    ]);
  });

  it("fails on --format xlsx without an output path", async () => {
    const { code, err } = await runCli([await sampleWorkbook(), "--format", "xlsx"]);
    expect(code).toBe(1);
    expect(err).toContain("needs an --output path");
  });

  it("exits nonzero on a missing workbook", async () => {
    const { code, err } = await runCli([join(tempDir(), "nope.xlsx")]);
    expect(code).toBe(1);
    expect(err).toContain("No such workbook");
  });

  it("exits nonzero on an unknown month", async () => {
    const { code, err } = await runCli([await sampleWorkbook(), "--months", "Jan,Smarch"]);
    expect(code).toBe(1);
    expect(err).toContain("Unknown month(s): Smarch");
  });

  it("exits nonzero on a bad key column", async () => {
    const { code, err } = await runCli([await sampleWorkbook(), "--key", "Nope"]);
    expect(code).toBe(1);
    expect(err).toContain("Key column 'Nope' is missing");
  });

  it.each(["--help", "--version"])("exits cleanly on %s", async (flag) => {
    const { code } = await runCli([flag]);
    expect(code).toBe(0);
  });
});
