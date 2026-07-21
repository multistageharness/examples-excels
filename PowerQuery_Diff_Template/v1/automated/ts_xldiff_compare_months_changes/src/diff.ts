/**
 * The diff engine: compare each month against the one before it.
 *
 * This is a direct port of the M code in `CompareMonths_changes_only_with_name.query`:
 *
 * - Each month is full-outer-joined to the previous month on the key column.
 * - A row whose key is absent from the previous month is `Added`; a row whose key is
 *   absent from the current month is `Removed`; a key in both is `Unchanged`.
 * - `Removed` rows carry the values from the *previous* month -- the month they were
 *   last seen in -- because the current month has nothing to show for them.
 * - The first month present (and any month whose predecessor is missing) is the
 *   `Base Month`: there is nothing to compare it against.
 *
 * `Unchanged` and `Base Month` rows are filtered out unless the caller asks for them.
 */

import { DEFAULT_KEY, MONTHS, MonthTable } from "./reader.js";
import type { CellValue, Row } from "./reader.js";

export const ADDED = "Added";
export const REMOVED = "Removed";
export const UNCHANGED = "Unchanged";
export const MODIFIED = "Modified";
export const BASE_MONTH = "Base Month";

export const MONTH_COLUMN = "Month";
export const STATUS_COLUMN = "Change_Status";

/** The statuses that represent an actual change to the roster of rows. */
export const CHANGE_STATUSES: readonly string[] = [ADDED, REMOVED, MODIFIED];

/** One output row: a key, what happened to it, and the data that goes with it. */
export class ChangeRow {
  constructor(
    public month: string,
    public key: CellValue,
    public status: string,
    public values: Row,
  ) {}

  /** Flatten to the output shape: Month, <key>, Change_Status, then the rest. */
  asDict(keyColumn: string, columns: readonly string[]): Record<string, CellValue> {
    const row: Record<string, CellValue> = {
      [MONTH_COLUMN]: this.month,
      [keyColumn]: this.key,
      [STATUS_COLUMN]: this.status,
    };
    for (const column of columns) {
      row[column] = this.values[column] ?? null;
    }
    return row;
  }
}

/** The full diff: the output column order plus the rows, ready to write. */
export class DiffResult {
  constructor(
    public keyColumn: string,
    public columns: string[],
    public changes: ChangeRow[],
  ) {}

  get header(): string[] {
    return [MONTH_COLUMN, this.keyColumn, STATUS_COLUMN, ...this.columns];
  }

  asDicts(): Record<string, CellValue>[] {
    return this.changes.map((change) => change.asDict(this.keyColumn, this.columns));
  }

  get length(): number {
    return this.changes.length;
  }
}

/**
 * Order keys the way a person reads them: numbers first and numerically, then text.
 *
 * Excel hands us ints, floats, strings and blanks in the same column, and those are not
 * mutually comparable -- hence the explicit rank. Mirrors the Python `_sort_key` tuple
 * `(rank, number, text)`.
 */
function sortKey(value: CellValue): [number, number, string] {
  if (value === null || value === undefined) {
    return [2, 0, ""];
  }
  if (typeof value === "boolean") {
    return [1, 0, String(value).toLowerCase()];
  }
  if (typeof value === "number") {
    return [0, value, ""];
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  const asNumber = asFloat(text);
  if (asNumber !== null) {
    return [0, asNumber, ""];
  }
  return [1, 0, text.toLowerCase()];
}

/** Parse a string as a float the way Python's `float()` does, else null. */
function asFloat(text: string): number | null {
  if (text.trim() === "") {
    return null;
  }
  const n = Number(text);
  return Number.isNaN(n) ? null : n;
}

function compareSortKeys(a: [number, number, string], b: [number, number, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

function valuesEqual(a: CellValue, b: CellValue): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

/** Compare one month against its predecessor. `previous === null` means base month. */
export function compareMonths(
  previous: MonthTable | null,
  current: MonthTable,
  key: string = DEFAULT_KEY,
  detectModified = false,
): ChangeRow[] {
  if (previous === null) {
    return current.rows
      .filter((row) => (row[key] ?? null) !== null)
      .map((row) => new ChangeRow(current.month, row[key], BASE_MONTH, row));
  }

  const currentRows = current.byKey(key);
  const previousRows = previous.byKey(key);

  const changes: ChangeRow[] = [];

  for (const [rowKey, row] of currentRows) {
    if (!previousRows.has(rowKey)) {
      changes.push(new ChangeRow(current.month, rowKey, ADDED, row));
      continue;
    }

    let status = UNCHANGED;
    if (detectModified && valuesDiffer(previousRows.get(rowKey)!, row, current.columns, key)) {
      status = MODIFIED;
    }
    changes.push(new ChangeRow(current.month, rowKey, status, row));
  }

  // Removed rows only exist in the previous month, so that is where their values come from.
  for (const [rowKey, row] of previousRows) {
    if (!currentRows.has(rowKey)) {
      changes.push(new ChangeRow(current.month, rowKey, REMOVED, row));
    }
  }

  changes.sort((a, b) => compareSortKeys(sortKey(a.key), sortKey(b.key)));
  return changes;
}

function valuesDiffer(
  previous: Row,
  current: Row,
  columns: readonly string[],
  key: string,
): boolean {
  return columns.some(
    (column) => column !== key && !valuesEqual(previous[column] ?? null, current[column] ?? null),
  );
}

/**
 * Walk the months in order and collect every change.
 *
 * A month whose immediate predecessor is absent from the workbook is treated as a base
 * month, exactly as `List.Generate` does in the M template: it carries `Prev` forward
 * as null and the comparison short-circuits.
 */
export function diffTables(
  tables: Map<string, MonthTable> | Record<string, MonthTable>,
  key: string = DEFAULT_KEY,
  months?: readonly string[],
  includeUnchanged = false,
  detectModified = false,
): DiffResult {
  const monthList = months ? [...months] : MONTHS;
  const get = (month: string): MonthTable | undefined =>
    tables instanceof Map ? tables.get(month) : tables[month];

  let changes: ChangeRow[] = [];
  const columns: string[] = [];
  const seenColumns = new Set<string>();

  monthList.forEach((month, index) => {
    const current = get(month);
    if (current === undefined) {
      return;
    }

    const previous = index > 0 ? get(monthList[index - 1]) ?? null : null;
    changes.push(...compareMonths(previous, current, key, detectModified));

    for (const column of current.columns) {
      if (column !== key && !seenColumns.has(column)) {
        seenColumns.add(column);
        columns.push(column);
      }
    }
  });

  if (!includeUnchanged) {
    changes = changes.filter((change) => CHANGE_STATUSES.includes(change.status));
  }

  return new DiffResult(key, columns, changes);
}
