/**
 * Generate examples/sample.xlsx -- a workbook shaped the way the diff expects.
 *
 * Three months as real Excel tables (tbl_Jan, tbl_Feb, tbl_Mar). The data is chosen so
 * that `xldiff examples/sample.xlsx` reproduces the reference Power Query output:
 *
 *     Month  ID   Change_Status  Status    Owner
 *     Feb    103  Removed        Active    Charlie
 *     Feb    105  Added          Active    Eve
 *     Mar    102  Removed        Inactive  Bob
 *     Mar    106  Added          New       Frank
 *
 * Note Bob (102): Active in Jan, flipped to Inactive in Feb, gone in Mar -- so his Removed
 * row carries Feb's values, not Jan's. That is the whole point of the "with_name" variant.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import ExcelJS from "exceljs";

const COLUMNS = ["ID", "Status", "Owner"];

const MONTHS: Record<string, (string | number)[][]> = {
  Jan: [
    [101, "Active", "Alice"],
    [102, "Active", "Bob"],
    [103, "Active", "Charlie"],
    [104, "Active", "Dana"],
  ],
  Feb: [
    [101, "Active", "Alice"],
    [102, "Inactive", "Bob"],
    [104, "Active", "Dana"],
    [105, "Active", "Eve"],
  ],
  Mar: [
    [101, "Active", "Alice"],
    [104, "Pending", "Dana"],
    [105, "Active", "Eve"],
    [106, "New", "Frank"],
  ],
};

export async function build(path: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();

  for (const [month, rows] of Object.entries(MONTHS)) {
    const worksheet = workbook.addWorksheet(month);
    worksheet.addTable({
      name: `tbl_${month}`,
      ref: "A1",
      headerRow: true,
      style: { theme: "TableStyleMedium9", showRowStripes: true },
      columns: COLUMNS.map((name) => ({ name })),
      rows,
    });
    [8, 12, 14].forEach((width, i) => {
      worksheet.getColumn(i + 1).width = width;
    });
  }

  mkdirSync(dirname(path), { recursive: true });
  await workbook.xlsx.writeFile(path);
  return path;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const target = process.argv[2] ?? "examples/sample.xlsx";
  build(target).then((path) => process.stdout.write(`wrote ${path}\n`));
}
