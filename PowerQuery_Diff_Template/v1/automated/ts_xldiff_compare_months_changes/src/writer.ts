/** Render a DiffResult as a console table, CSV, JSON, or a styled .xlsx sheet. */

import ExcelJS from "exceljs";

import { ADDED, MODIFIED, REMOVED, DiffResult } from "./diff.js";
import type { CellValue } from "./reader.js";

export const FORMATS = ["table", "csv", "json", "xlsx"] as const;
export type Format = (typeof FORMATS)[number];

const HEADER_FILL = "FFED7D31";
const STATUS_FILLS: Record<string, string> = {
  [ADDED]: "FFE2EFDA",
  [REMOVED]: "FFFCE4E4",
  [MODIFIED]: "FFFFF2CC",
};

/** Pick the output format: an explicit --format wins, else infer from the extension. */
export function formatFor(path: string | null | undefined, requested: string | null | undefined): Format {
  if (requested) {
    return requested as Format;
  }
  if (path) {
    const suffix = (path.match(/\.[^./\\]+$/)?.[0] ?? "").toLowerCase();
    if (suffix === ".xlsx" || suffix === ".xlsm") return "xlsx";
    if (suffix === ".json") return "json";
    if (suffix === ".csv" || suffix === ".txt") return "csv";
  }
  return "table";
}

/** ISO-format a Date the way Python's datetime.isoformat() does (no trailing Z). */
function isoformat(value: Date): string {
  return value.toISOString().replace(/\.000Z$/, "").replace(/Z$/, "");
}

/** Excel dates arrive as Dates; make them JSON- and CSV-safe. Non-dates pass through. */
function scalar(value: CellValue): CellValue {
  return value instanceof Date ? isoformat(value) : value;
}

/** Python-style str() of a scalar, for the text and CSV formats. */
function text(value: CellValue): string {
  if (value === null || value === undefined) return "";
  const scalared = scalar(value);
  if (typeof scalared === "boolean") return scalared ? "True" : "False";
  return String(scalared);
}

/** A fixed-width table for the terminal. */
export function toTable(result: DiffResult): string {
  const header = result.header;
  const rows = result.asDicts().map((row) => header.map((column) => text(row[column])));

  const widths = header.map((column) => column.length);
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], cell.length);
    });
  }

  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").replace(/\s+$/, "");

  const out = [line(header), widths.map((width) => "-".repeat(width)).join("  ")];
  out.push(...rows.map(line));
  return out.join("\n");
}

function csvField(value: CellValue): string {
  const s = text(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(result: DiffResult): string {
  const header = result.header;
  const lines = [header.map(csvField).join(",")];
  for (const row of result.asDicts()) {
    lines.push(header.map((column) => csvField(row[column])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function toJson(result: DiffResult): string {
  const payload = result.asDicts().map((row) => {
    const obj: Record<string, CellValue> = {};
    for (const [column, value] of Object.entries(row)) {
      obj[column] = scalar(value);
    }
    return obj;
  });
  return JSON.stringify(payload, null, 2);
}

function columnLetter(index: number): string {
  let n = index;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Write the changes to a single sheet, styled like the Power Query output. */
export async function writeXlsx(result: DiffResult, path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Changes");

  const header = result.header;
  const rows = result.asDicts();
  const dataRows = rows.map((row) => header.map((column) => scalar(row[column])));
  const statusColumn = "Change_Status";

  // An Excel Table needs at least one data row; below that, fall back to an autofilter.
  // Either way the cells are written first, then styled on top.
  const span = `A1:${columnLetter(header.length)}${dataRows.length + 1}`;
  if (dataRows.length > 0) {
    worksheet.addTable({
      name: "tbl_Changes",
      ref: "A1",
      headerRow: true,
      style: { theme: "TableStyleMedium2", showRowStripes: true, showColumnStripes: false },
      columns: header.map((name) => ({ name, filterButton: false })),
      rows: dataRows,
    });
  } else {
    worksheet.addRow(header);
    worksheet.autoFilter = span;
  }

  // Header row: bold white text on an orange fill, left-aligned.
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "left" };
  });

  // Data rows: fill-coded by status.
  rows.forEach((row, i) => {
    const fill = STATUS_FILLS[String(row[statusColumn] ?? "")];
    if (fill) {
      worksheet.getRow(i + 2).eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      });
    }
  });

  // Column widths: longest value plus padding, capped at 40.
  header.forEach((column, index) => {
    const longest = Math.max(column.length, ...rows.map((row) => text(row[column]).length));
    worksheet.getColumn(index + 1).width = Math.min(longest + 4, 40);
  });

  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  await workbook.xlsx.writeFile(path);
}

/** Render to a string. `xlsx` is binary and must go through writeXlsx instead. */
export function render(result: DiffResult, fmt: string): string {
  if (fmt === "table") return toTable(result);
  if (fmt === "csv") return toCsv(result);
  if (fmt === "json") return toJson(result);
  throw new Error(`'${fmt}' cannot be rendered as text; use writeXlsx()`);
}
