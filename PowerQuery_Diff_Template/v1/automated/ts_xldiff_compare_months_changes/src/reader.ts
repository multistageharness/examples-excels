/**
 * Load the per-month tables out of an .xlsx workbook.
 *
 * Two layouts are supported, in this order of preference:
 *
 * 1. Real Excel Tables (ListObjects) named `tbl_Jan` ... `tbl_Dec` -- the layout the
 *    Power Query template expects, since `Excel.CurrentWorkbook()` only sees named tables.
 * 2. Plain worksheets titled `Jan` ... `Dec`, with a header row in row 1. This is the
 *    fallback for the far more common workbook that never had tables defined.
 *
 * Months that are absent are simply not returned; the diff engine treats a gap the same
 * way the M code does.
 */

import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";

import {
  gridFromRange,
  gridFromUsedRange,
  readXlsx,
  type CellValue,
  type SheetData,
  type WorkbookData,
} from "./xlsx.js";

export type { CellValue };
export type Row = Record<string, CellValue>;

export const MONTHS: string[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export const DEFAULT_TABLE_PREFIX = "tbl_";
export const DEFAULT_KEY = "ID";

/** The workbook cannot be diffed as-is (missing file, no months, missing key). */
export class WorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookError";
  }
}

/** One month's rows, keyed by the diff key. */
export class MonthTable {
  constructor(
    public month: string,
    public columns: string[],
    public rows: Row[] = [],
    public source = "",
  ) {}

  /** Index the rows by key. Later duplicates win, matching a join's last-write. */
  byKey(key: string): Map<CellValue, Row> {
    const index = new Map<CellValue, Row>();
    for (const row of this.rows) {
      const value = row[key] ?? null;
      if (value !== null) {
        index.set(value, row);
      }
    }
    return index;
  }
}

/** Normalize a cell value: blank-ish strings become null, others are stripped. */
function clean(value: CellValue): CellValue {
  if (typeof value === "string") {
    const stripped = value.trim();
    return stripped === "" ? null : stripped;
  }
  return value;
}

/** Turn a rectangular block of cell values (header row first) into typed rows. */
function rowsFromGrid(grid: CellValue[][]): { columns: string[]; rows: Row[] } {
  if (grid.length === 0) {
    return { columns: [], rows: [] };
  }

  const headerCells = grid[0].map(clean);
  // Trailing unnamed columns are Excel padding, not data.
  while (headerCells.length > 0 && headerCells[headerCells.length - 1] === null) {
    headerCells.pop();
  }
  if (headerCells.length === 0) {
    return { columns: [], rows: [] };
  }

  const columns = headerCells.map((cell, i) => (cell !== null ? String(cell) : `Column${i + 1}`));

  const rows: Row[] = [];
  for (const raw of grid.slice(1)) {
    const values = raw.slice(0, columns.length).map(clean);
    if (values.every((value) => value === null)) {
      continue; // spacer row
    }
    while (values.length < columns.length) {
      values.push(null);
    }
    const row: Row = {};
    columns.forEach((column, i) => {
      row[column] = values[i];
    });
    rows.push(row);
  }

  return { columns, rows };
}

function readNamedTables(
  workbook: WorkbookData,
  prefix: string,
  months: readonly string[],
): Map<string, MonthTable> {
  const wanted = new Map<string, string>();
  for (const month of months) {
    wanted.set(`${prefix}${month}`.toLowerCase(), month);
  }

  const found = new Map<string, MonthTable>();
  for (const sheet of workbook.sheets) {
    for (const table of sheet.tables) {
      const month = wanted.get(table.name.toLowerCase());
      if (month === undefined) continue;

      const { columns, rows } = rowsFromGrid(gridFromRange(sheet, table.ref));
      if (columns.length > 0) {
        found.set(month, new MonthTable(month, columns, rows, `table ${table.name}`));
      }
    }
  }
  return found;
}

function readSheets(
  workbook: WorkbookData,
  months: readonly string[],
): Map<string, MonthTable> {
  const wanted = new Map<string, string>();
  for (const month of months) {
    wanted.set(month.toLowerCase(), month);
  }

  const found = new Map<string, MonthTable>();
  for (const sheet of workbook.sheets) {
    const month = wanted.get(sheet.name.trim().toLowerCase());
    if (month === undefined) continue;

    const { columns, rows } = rowsFromGrid(gridFromUsedRange(sheet));
    if (columns.length > 0) {
      found.set(month, new MonthTable(month, columns, rows, `sheet ${sheet.name}`));
    }
  }
  return found;
}

export interface ReadOptions {
  key?: string;
  tablePrefix?: string;
  months?: readonly string[];
}

/**
 * Read every month present in the workbook, keyed by month name.
 *
 * Throws WorkbookError if the file is unreadable, no month is found, or a month that
 * was found lacks the key column -- the diff is meaningless without a join key.
 */
export function readWorkbook(path: string, options: ReadOptions = {}): Map<string, MonthTable> {
  const key = options.key ?? DEFAULT_KEY;
  const tablePrefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
  const months = options.months ? [...options.months] : MONTHS;

  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new WorkbookError(`No such workbook: ${path}`);
  }

  let workbook: WorkbookData;
  try {
    workbook = readXlsx(path);
  } catch (exc) {
    const cause = exc instanceof Error ? exc.message : String(exc);
    throw new WorkbookError(`Could not open ${basename(path)} as an .xlsx workbook: ${cause}`);
  }

  let tables = readNamedTables(workbook, tablePrefix, months);
  if (tables.size === 0) {
    tables = readSheets(workbook, months);
  }

  if (tables.size === 0) {
    throw new WorkbookError(
      `${basename(path)} has no month tables. Expected Excel tables named ` +
        `'${tablePrefix}Jan'...'${tablePrefix}Dec', or sheets named 'Jan'...'Dec'.`,
    );
  }

  const monthIndex = (month: string): number => months.indexOf(month);
  const missingKey = [...tables.values()]
    .filter((table) => !table.columns.includes(key))
    .map((table) => table.month)
    .sort((a, b) => monthIndex(a) - monthIndex(b));
  if (missingKey.length > 0) {
    throw new WorkbookError(
      `Key column '${key}' is missing from: ${missingKey.join(", ")}. ` +
        `Pass --key to name the column that identifies a row.`,
    );
  }

  const ordered = new Map<string, MonthTable>();
  for (const month of months) {
    const table = tables.get(month);
    if (table !== undefined) {
      ordered.set(month, table);
    }
  }
  return ordered;
}

export type { SheetData };
