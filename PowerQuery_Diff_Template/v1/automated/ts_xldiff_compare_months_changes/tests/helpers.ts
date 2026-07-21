import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";

import { build as buildSample } from "../scripts/make-sample.js";

export { buildSample };

/** A fresh temp directory, unique per call -- the stand-in for pytest's tmp_path. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "xldiff-"));
}

export interface MakeWorkbookOptions {
  columns?: string[];
  asTables?: boolean;
  prefix?: string;
  name?: string;
  dir?: string;
}

/** Build an .xlsx from {month: rows}, as named tables or as bare sheets. */
export async function makeWorkbook(
  months: Record<string, (string | number | null)[][]>,
  options: MakeWorkbookOptions = {},
): Promise<string> {
  const columns = options.columns ?? ["ID", "Status", "Owner"];
  const asTables = options.asTables ?? true;
  const prefix = options.prefix ?? "tbl_";
  const name = options.name ?? "book.xlsx";
  const dir = options.dir ?? tempDir();

  const workbook = new ExcelJS.Workbook();

  for (const [month, rows] of Object.entries(months)) {
    const worksheet = workbook.addWorksheet(month);
    if (asTables && rows.length > 0) {
      worksheet.addTable({
        name: `${prefix}${month}`,
        ref: "A1",
        headerRow: true,
        columns: columns.map((columnName) => ({ name: columnName })),
        rows: rows.map((row) => [...row]),
      });
    } else {
      worksheet.addRow(columns);
      for (const row of rows) {
        worksheet.addRow([...row]);
      }
    }
  }

  const path = join(dir, name);
  await workbook.xlsx.writeFile(path);
  return path;
}

/** The reference workbook: Jan/Feb/Mar as Excel tables, matching the M template. */
export async function sampleWorkbook(): Promise<string> {
  return buildSample(join(tempDir(), "sample.xlsx"));
}
