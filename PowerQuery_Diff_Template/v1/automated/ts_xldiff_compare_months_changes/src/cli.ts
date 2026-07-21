#!/usr/bin/env node
/** Command line entry point: take an .xlsx workbook, print (or write) what changed. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { VERSION } from "./index.js";
import { diffTables } from "./diff.js";
import { DEFAULT_KEY, DEFAULT_TABLE_PREFIX, MONTHS, WorkbookError, readWorkbook } from "./reader.js";
import { FORMATS, formatFor, render, writeXlsx } from "./writer.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const PROG = "xldiff";

const HELP = `usage: ${PROG} [-h] [-o OUTPUT] [-f {${FORMATS.join(",")}}] [-k COLUMN]
              [--table-prefix PREFIX] [--months LIST] [--detect-modified]
              [--all] [--version]
              workbook

Compare the monthly tables in an Excel workbook and output only the rows that
changed -- added and removed rows, with all their columns.

positional arguments:
  workbook              path to the .xlsx workbook to compare

options:
  -h, --help            show this help message and exit
  -o, --output PATH     write the result to this file (default: print to stdout)
  -f, --format FMT      output format: ${FORMATS.join(" | ")}
                        (default: inferred from --output's extension, else 'table')
  -k, --key COLUMN      column that identifies a row across months (default: ${DEFAULT_KEY})
  --table-prefix PREFIX prefix of the per-month Excel table names (default: ${DEFAULT_TABLE_PREFIX})
  --months LIST         comma-separated months, in order, to compare (default: Jan..Dec)
  --detect-modified     also report rows whose key stayed but whose values changed, as 'Modified'
  --all                 include Unchanged and Base Month rows too, instead of only the changes
  --version             show program's version number and exit

The workbook should hold one table per month, either as Excel tables named
tbl_Jan...tbl_Dec or as sheets named Jan...Dec. Each month is compared against
the month before it.`;

interface Args {
  workbook: string;
  output: string | null;
  format: string | null;
  key: string;
  tablePrefix: string;
  months: string | null;
  detectModified: boolean;
  all: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    workbook: "",
    output: null,
    format: null,
    key: DEFAULT_KEY,
    tablePrefix: DEFAULT_TABLE_PREFIX,
    months: null,
    detectModified: false,
    all: false,
  };
  const positionals: string[] = [];

  const tokens = [...argv];
  const takeValue = (name: string, inline: string | undefined): string => {
    if (inline !== undefined) return inline;
    const next = tokens.shift();
    if (next === undefined) throw new UsageError(`argument ${name}: expected one argument`);
    return next;
  };

  while (tokens.length > 0) {
    const token = tokens.shift() as string;
    let name = token;
    let inline: string | undefined;
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      name = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    switch (name) {
      case "-h":
      case "--help":
        process.stdout.write(HELP + "\n");
        process.exit(EXIT_OK);
        break;
      case "--version":
        process.stdout.write(`${PROG} ${VERSION}\n`);
        process.exit(EXIT_OK);
        break;
      case "-o":
      case "--output":
        args.output = takeValue(name, inline);
        break;
      case "-f":
      case "--format": {
        const value = takeValue(name, inline);
        if (!FORMATS.includes(value as never)) {
          throw new UsageError(
            `argument -f/--format: invalid choice: '${value}' (choose from ${FORMATS.map((f) => `'${f}'`).join(", ")})`,
          );
        }
        args.format = value;
        break;
      }
      case "-k":
      case "--key":
        args.key = takeValue(name, inline);
        break;
      case "--table-prefix":
        args.tablePrefix = takeValue(name, inline);
        break;
      case "--months":
        args.months = takeValue(name, inline);
        break;
      case "--detect-modified":
        args.detectModified = true;
        break;
      case "--all":
        args.all = true;
        break;
      default:
        if (name.startsWith("-") && name !== "-") {
          throw new UsageError(`unrecognized arguments: ${token}`);
        }
        positionals.push(token);
    }
  }

  if (positionals.length === 0) {
    throw new UsageError("the following arguments are required: workbook");
  }
  if (positionals.length > 1) {
    throw new UsageError(`unrecognized arguments: ${positionals.slice(1).join(" ")}`);
  }
  args.workbook = positionals[0];
  return args;
}

function parseMonths(raw: string | null): string[] {
  if (!raw) {
    return [...MONTHS];
  }

  const months = raw.split(",").map((month) => month.trim()).filter((month) => month !== "");
  const unknown = months.filter((month) => !MONTHS.includes(month));
  if (unknown.length > 0) {
    throw new WorkbookError(
      `Unknown month(s): ${unknown.join(", ")}. Expected any of: ${MONTHS.join(", ")}.`,
    );
  }
  if (months.length < 2) {
    throw new WorkbookError("--months needs at least two months to have anything to compare.");
  }
  return months;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    if (exc instanceof UsageError) {
      process.stderr.write(`${PROG}: error: ${exc.message}\n`);
      return EXIT_USAGE;
    }
    throw exc;
  }

  let months: string[];
  let tables;
  let result;
  try {
    months = parseMonths(args.months);
    tables = readWorkbook(args.workbook, {
      key: args.key,
      tablePrefix: args.tablePrefix,
      months,
    });
    result = diffTables(tables, args.key, months, args.all, args.detectModified);
  } catch (exc) {
    if (exc instanceof WorkbookError) {
      process.stderr.write(`${PROG}: ${exc.message}\n`);
      return EXIT_ERROR;
    }
    throw exc;
  }

  const fmt = formatFor(args.output, args.format);

  if (fmt === "xlsx" && args.output === null) {
    process.stderr.write(`${PROG}: --format xlsx needs an --output path to write to.\n`);
    return EXIT_ERROR;
  }

  if (args.output === null) {
    process.stdout.write(render(result, fmt) + "\n");
  } else {
    mkdirSync(dirname(args.output), { recursive: true });
    if (fmt === "xlsx") {
      await writeXlsx(result, args.output);
    } else {
      writeFileSync(args.output, render(result, fmt), { encoding: "utf-8" });
    }

    const found = [...tables.keys()].sort((a, b) => months.indexOf(a) - months.indexOf(b)).join(", ");
    process.stderr.write(
      `${PROG}: ${result.length} changed row(s) across ${found} -> ${args.output}\n`,
    );
  }

  return EXIT_OK;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((exc) => {
      process.stderr.write(`${PROG}: ${exc instanceof Error ? exc.message : String(exc)}\n`);
      process.exit(EXIT_ERROR);
    });
}
