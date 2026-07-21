/**
 * A small, self-contained .xlsx reader.
 *
 * An .xlsx file is a zip of XML parts. We read it directly -- no Excel, no Power Query,
 * no third-party spreadsheet engine that chokes on another tool's tables. This gives us
 * a producer-agnostic view of a workbook: sheets, their cells (typed and value-only,
 * using cached formula results), and any named tables (ListObjects) they define.
 */

import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

export type CellValue = string | number | boolean | Date | null;

export interface TableDef {
  name: string;
  ref: string;
}

export interface SheetData {
  name: string;
  cells: Map<string, CellValue>; // keyed by "row,col" (1-based)
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
  tables: TableDef[];
}

export interface WorkbookData {
  sheets: SheetData[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false, // keep every <v>/<t> as a raw string; we type it ourselves
  parseAttributeValue: false,
  trimValues: false, // preserve whitespace; the caller decides what is blank
  isArray: (name) => ["sheet", "row", "c", "si", "r", "xf", "numFmt", "Relationship"].includes(name),
});

/** Builtin numFmtIds that denote a date/time (per ECMA-376). */
const BUILTIN_DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Convert an A1-style column reference ("A", "AB") to a 1-based index. */
function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

/** Split a cell reference ("B12") into [row, col] 1-based indices. */
function splitRef(ref: string): [number, number] {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) {
    throw new Error(`Bad cell reference: ${ref}`);
  }
  return [parseInt(match[2], 10), colToIndex(match[1])];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Is this number format a date/time format? */
function isDateFormat(numFmtId: number, customCodes: Map<number, string>): boolean {
  if (BUILTIN_DATE_FMT_IDS.has(numFmtId)) {
    return true;
  }
  const code = customCodes.get(numFmtId);
  if (!code) {
    return false;
  }
  // Strip color/condition brackets, quoted literals and backslash escapes, then look for
  // date/time tokens. A currency or plain-number format has none of y/d/h and no lone m/s.
  const stripped = code
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Excel serial date -> JS Date (UTC). Honors the 1904 date system when set. */
function excelSerialToDate(serial: number, date1904: boolean): Date {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const offset = date1904 ? serial + 1462 : serial;
  return new Date(epoch + Math.round(offset * MS_PER_DAY));
}

function textFromInline(is: any): string {
  // <is> may hold a single <t> or a run of <r><t>..</t></r> pieces.
  if (is == null) return "";
  if (typeof is === "string") return is;
  let out = "";
  if (is.t !== undefined) {
    out += typeof is.t === "string" ? is.t : (is.t["#text"] ?? "");
  }
  for (const run of asArray(is.r)) {
    const t = run?.t;
    out += typeof t === "string" ? t : (t?.["#text"] ?? "");
  }
  return out;
}

function textFromSharedString(si: any): string {
  return textFromInline(si);
}

/** Parse xl/sharedStrings.xml into a flat array of strings. */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const doc = parser.parse(xml);
  const sst = doc.sst;
  if (!sst) return [];
  return asArray(sst.si).map(textFromSharedString);
}

interface StyleInfo {
  /** For each cellXfs index, whether it points at a date/time number format. */
  isDate: boolean[];
}

/** Parse xl/styles.xml: map each cellXfs entry to whether it is a date format. */
function parseStyles(xml: string | undefined): StyleInfo {
  if (!xml) return { isDate: [] };
  const doc = parser.parse(xml);
  const styleSheet = doc.styleSheet ?? {};

  const customCodes = new Map<number, string>();
  for (const fmt of asArray(styleSheet.numFmts?.numFmt)) {
    const id = parseInt(fmt["@_numFmtId"], 10);
    customCodes.set(id, fmt["@_formatCode"] ?? "");
  }

  const isDate = asArray(styleSheet.cellXfs?.xf).map((xf) => {
    const numFmtId = parseInt(xf["@_numFmtId"] ?? "0", 10);
    return isDateFormat(numFmtId, customCodes);
  });

  return { isDate };
}

/** Turn one `<c>` element into a typed cell value. */
function cellValue(
  c: any,
  sharedStrings: string[],
  styles: StyleInfo,
  date1904: boolean,
): CellValue {
  const type = c["@_t"];
  const styleIndex = c["@_s"] !== undefined ? parseInt(c["@_s"], 10) : undefined;

  if (type === "inlineStr") {
    return textFromInline(c.is) || null;
  }

  const rawV = c.v;
  if (rawV === undefined || rawV === null) {
    return null;
  }
  const v = typeof rawV === "string" ? rawV : (rawV["#text"] ?? String(rawV));

  if (type === "s") {
    return sharedStrings[parseInt(v, 10)] ?? null;
  }
  if (type === "str") {
    return v; // cached string result of a formula
  }
  if (type === "b") {
    return v === "1" || v.toLowerCase() === "true";
  }
  if (type === "e") {
    return v; // error text, e.g. "#DIV/0!"
  }

  // Numeric (t="n" or absent). It may be a date in disguise -- check the style.
  const num = Number(v);
  if (Number.isNaN(num)) {
    return v;
  }
  if (styleIndex !== undefined && styles.isDate[styleIndex]) {
    return excelSerialToDate(num, date1904);
  }
  return num;
}

/** Resolve a relationship target that may be absolute ("/xl/..") or relative ("../.."). */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const parts = baseDir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function parseRels(xml: string | undefined): Map<string, { type: string; target: string }> {
  const rels = new Map<string, { type: string; target: string }>();
  if (!xml) return rels;
  const doc = parser.parse(xml);
  for (const rel of asArray(doc.Relationships?.Relationship)) {
    rels.set(rel["@_Id"], { type: rel["@_Type"] ?? "", target: rel["@_Target"] ?? "" });
  }
  return rels;
}

const WORKSHEET_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const TABLE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";

/** Read a workbook from disk into sheets, cells, and table definitions. */
export function readXlsx(path: string): WorkbookData {
  const buffer = readFileSync(path);
  const files = unzipSync(new Uint8Array(buffer));
  const text = (name: string): string | undefined =>
    files[name] ? strFromU8(files[name]) : undefined;

  const sharedStrings = parseSharedStrings(text("xl/sharedStrings.xml"));
  const styles = parseStyles(text("xl/styles.xml"));

  const workbookDoc = parser.parse(text("xl/workbook.xml") ?? "<workbook/>");
  const workbook = workbookDoc.workbook ?? {};
  const date1904 =
    String(workbook.workbookPr?.["@_date1904"] ?? "").toLowerCase() === "1" ||
    String(workbook.workbookPr?.["@_date1904"] ?? "").toLowerCase() === "true";

  const workbookRels = parseRels(text("xl/_rels/workbook.xml.rels"));

  const sheets: SheetData[] = [];

  for (const sheetEntry of asArray(workbook.sheets?.sheet)) {
    const name = sheetEntry["@_name"] ?? "";
    const rid = sheetEntry["@_r:id"];
    const rel = rid ? workbookRels.get(rid) : undefined;
    if (!rel) continue;

    const sheetPath = resolveTarget("xl", rel.target);
    const sheetXml = text(sheetPath);
    if (sheetXml === undefined) continue;

    const sheetDoc = parser.parse(sheetXml);
    const worksheet = sheetDoc.worksheet ?? {};

    const cells = new Map<string, CellValue>();
    let minRow = Infinity;
    let maxRow = 0;
    let minCol = Infinity;
    let maxCol = 0;

    for (const row of asArray(worksheet.sheetData?.row)) {
      for (const c of asArray(row.c)) {
        const ref = c["@_r"];
        if (!ref) continue;
        const value = cellValue(c, sharedStrings, styles, date1904);
        if (value === null) continue; // absent/blank -- keep the grid sparse
        const [r, col] = splitRef(ref);
        cells.set(`${r},${col}`, value);
        if (r < minRow) minRow = r;
        if (r > maxRow) maxRow = r;
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
      }
    }

    if (cells.size === 0) {
      minRow = minCol = 1;
      maxRow = maxCol = 0;
    }

    // Named tables: sheet -> its rels -> the table parts it references.
    const tables: TableDef[] = [];
    const relsPath = sheetPath.replace(/([^/]+)$/, "_rels/$1.rels");
    const sheetRels = parseRels(text(relsPath));
    const baseDir = sheetPath.split("/").slice(0, -1).join("/");
    for (const { type, target } of sheetRels.values()) {
      if (type !== TABLE_REL) continue;
      const tableXml = text(resolveTarget(baseDir, target));
      if (!tableXml) continue;
      const tableDoc = parser.parse(tableXml);
      const table = tableDoc.table;
      if (!table) continue;
      const tableName = table["@_name"] ?? table["@_displayName"];
      const ref = table["@_ref"];
      if (tableName && ref) {
        tables.push({ name: String(tableName), ref: String(ref) });
      }
    }

    sheets.push({ name, cells, minRow, maxRow, minCol, maxCol, tables });
  }

  return { sheets };
}

/** Extract a dense, row-major grid of cell values from a sheet over a cell range. */
export function gridFromRange(sheet: SheetData, ref: string): CellValue[][] {
  const [start, end] = ref.split(":");
  const [minRow, minCol] = splitRef(start);
  const [maxRow, maxCol] = splitRef(end ?? start);
  return denseGrid(sheet, minRow, maxRow, minCol, maxCol);
}

/** Extract a dense grid over a sheet's whole used range (like openpyxl iter_rows). */
export function gridFromUsedRange(sheet: SheetData): CellValue[][] {
  if (sheet.maxRow < sheet.minRow || sheet.maxCol < sheet.minCol) {
    return [];
  }
  return denseGrid(sheet, sheet.minRow, sheet.maxRow, sheet.minCol, sheet.maxCol);
}

function denseGrid(
  sheet: SheetData,
  minRow: number,
  maxRow: number,
  minCol: number,
  maxCol: number,
): CellValue[][] {
  const grid: CellValue[][] = [];
  for (let r = minRow; r <= maxRow; r++) {
    const row: CellValue[] = [];
    for (let col = minCol; col <= maxCol; col++) {
      row.push(sheet.cells.get(`${r},${col}`) ?? null);
    }
    grid.push(row);
  }
  return grid;
}

export { WORKSHEET_REL };
