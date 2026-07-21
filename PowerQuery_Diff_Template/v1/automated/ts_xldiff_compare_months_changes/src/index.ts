/**
 * Compare monthly tables in an Excel workbook and emit only the rows that changed.
 *
 * A native Node/TypeScript port of the `CompareMonths_changes_only_with_name` Power Query
 * (M) template: it walks the twelve months in chronological order, full-outer-joins each
 * month against the one before it on a key column, and reports the rows that were
 * `Added` or `Removed` -- carrying every column along, with removed rows populated from
 * the month they disappeared from.
 */

export const VERSION = "1.0.0";

export {
  ADDED,
  BASE_MONTH,
  MODIFIED,
  REMOVED,
  UNCHANGED,
  MONTH_COLUMN,
  STATUS_COLUMN,
  CHANGE_STATUSES,
  ChangeRow,
  DiffResult,
  compareMonths,
  diffTables,
} from "./diff.js";

export {
  MONTHS,
  DEFAULT_KEY,
  DEFAULT_TABLE_PREFIX,
  MonthTable,
  WorkbookError,
  readWorkbook,
} from "./reader.js";
export type { CellValue, Row, ReadOptions } from "./reader.js";

export {
  FORMATS,
  formatFor,
  render,
  writeXlsx,
  toTable,
  toCsv,
  toJson,
} from "./writer.js";
export type { Format } from "./writer.js";
