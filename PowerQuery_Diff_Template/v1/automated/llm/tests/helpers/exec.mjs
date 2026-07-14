/**
 * Execution harness: runs the skills' real entrypoints as subprocesses.
 *
 * The sibling `harness.mjs` asks a *model* about the skills. This file asks the
 * skills themselves — it spawns `scripts/*.py` and `scripts/*.sh` against real
 * workbooks and hands back their real stdout/stderr/exit code. Nothing here is
 * mocked: if a script is broken, these tests go red.
 *
 * Fixtures are generated (never committed) by py-xlsx-diff-commons' own
 * make_fixtures.py, so the workbooks the suite runs against are produced by the
 * skill under test rather than by a copy of it that could drift.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKILLS_DIR } from './skills.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** automated/ — the root the reference project and the skills tree both live under. */
const AUTOMATED_DIR = path.resolve(HERE, '../../..');

/** The Power Query template that py-powerquery-m-diff-inject operates on. */
export const PQ_TEMPLATE = path.resolve(AUTOMATED_DIR, '../data_sample_001_with_query.xlsx');

/** The M query the injector writes into the template. */
export const PQ_QUERY = path.resolve(AUTOMATED_DIR, '../CompareMonths_changes_only_with_name.query');

/** Absolute path to a script shipped by a skill. */
export function script(skill, rel) {
  return path.join(SKILLS_DIR, skill, 'scripts', rel);
}

/**
 * Run a command to completion and capture everything it said.
 *
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * A Python that can `import openpyxl`.
 *
 * The engine, the inspector, the exporter and the verifier all need it. The
 * reference project ships a virtualenv with it (as every SKILL.md says); an
 * interpreter can also be named explicitly via XLDIFF_PYTHON.
 */
function findPython() {
  const candidates = [
    process.env.XLDIFF_PYTHON,
    path.join(AUTOMATED_DIR, 'CompareMonths_changes_only_with_name/.venv/bin/python'),
    'python3',
  ].filter(Boolean);

  for (const py of candidates) {
    try {
      const r = spawnSync(py, ['-c', 'import openpyxl'], { encoding: 'utf8' });
      if (r.status === 0) return py;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** An interpreter with openpyxl, or null. */
export const PYTHON = findPython();

/**
 * A plain `python3`, with no guarantee that openpyxl is importable.
 *
 * py-powerquery-m-diff-inject claims to be standard-library-only. Running it
 * through this rather than through PYTHON is what turns that claim into a test.
 */
export const SYS_PYTHON = 'python3';

/** Message used when the suite cannot run at all, rather than skipping silently. */
export const NO_PYTHON =
  'No Python with openpyxl found. Expected the reference project virtualenv at ' +
  'automated/CompareMonths_changes_only_with_name/.venv, or set XLDIFF_PYTHON to an ' +
  'interpreter that can `import openpyxl`.';

/** Run py-xlsx-diff-commons' engine (the CLI every other py- skill calls). */
export function xldiff(args) {
  return run(PYTHON, [script('py-xlsx-diff-commons', 'xldiff_core.py'), ...args]);
}

/** Run the bash engine — the shell twin of the above. */
export function xldiffSh(args) {
  return run('bash', [script('bash-xlsx-diff-commons', 'xldiff.sh'), ...args]);
}

/** Evaluate a snippet of Python with openpyxl available; returns trimmed stdout. */
export function py(code, args = []) {
  const r = run(PYTHON, ['-c', code, ...args]);
  if (r.code !== 0) throw new Error(`python failed (${r.code}):\n${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Generate the suite's fixture workbooks with the skill's own generator.
 *
 * @returns {{ dir: string, sample: string, sheets: string, gap: string, messy: string, cleanup: Function }}
 */
export function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xldiff-fixtures-'));
  const r = run(PYTHON, [script('py-xlsx-diff-commons', 'make_fixtures.py'), dir]);
  if (r.code !== 0) {
    throw new Error(`make_fixtures.py failed (${r.code}):\n${r.stderr}`);
  }
  const at = (name) => path.join(dir, name);
  return {
    dir,
    sample: at('sample.xlsx'),
    sheets: at('sheets.xlsx'),
    gap: at('gap.xlsx'),
    messy: at('messy.xlsx'),
    out: at, // somewhere to write outputs, alongside the fixtures
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * The golden diff of `sample.xlsx`, quoted from py-xlsx-diff-commons/SKILL.md.
 *
 * The load-bearing row is `Mar 102 Removed Inactive Bob`: Bob was Active in Jan,
 * Inactive in Feb, and gone in Mar — so his Removed row is labelled with the month
 * the removal was observed in (Mar) but carries the values from the month before
 * it (Feb). Emitting Jan's `Active`, or blanks, is the bug this suite exists to
 * catch, and it still produces a plausible-looking file.
 */
export const GOLDEN_ROWS = [
  ['Feb', 103, 'Removed', 'Active', 'Charlie'],
  ['Feb', 105, 'Added', 'Active', 'Eve'],
  ['Mar', 102, 'Removed', 'Inactive', 'Bob'],
  ['Mar', 106, 'Added', 'New', 'Frank'],
];

/** The same golden, as the fixed-width table the CLI prints by default. */
export const GOLDEN_TABLE = [
  'Month  ID   Change_Status  Status    Owner',
  '-----  ---  -------------  --------  -------',
  'Feb    103  Removed        Active    Charlie',
  'Feb    105  Added          Active    Eve',
  'Mar    102  Removed        Inactive  Bob',
  'Mar    106  Added          New       Frank',
].join('\n');

/** Read an emitted .xlsx back through openpyxl as [header, ...rows]. */
export function readXlsx(file, sheet = 'Changes') {
  const out = py(
    [
      'import json,sys,openpyxl',
      'ws=openpyxl.load_workbook(sys.argv[1])[sys.argv[2]]',
      'print(json.dumps([[c.value for c in r] for r in ws.iter_rows()]))',
    ].join('\n'),
    [file, sheet],
  );
  return JSON.parse(out);
}

/** Read the structural contract of an emitted .xlsx: sheets, tables, freeze, fills. */
export function readXlsxShape(file) {
  const out = py(
    [
      'import json,sys,openpyxl',
      'wb=openpyxl.load_workbook(sys.argv[1])',
      'ws=wb["Changes"]',
      'rows=[[c.value for c in r] for r in ws.iter_rows()]',
      'fills=[ws.cell(r,1).fill.start_color.rgb for r in range(2, ws.max_row+1)]',
      'print(json.dumps({',
      '  "sheets": wb.sheetnames,',
      '  "tables": list(ws.tables),',
      '  "freeze": ws.freeze_panes,',
      '  "header_fill": ws["A1"].fill.start_color.rgb,',
      '  "header_bold": ws["A1"].font.bold,',
      '  "autofilter": str(ws.auto_filter.ref) if ws.auto_filter.ref else None,',
      '  "rows": rows,',
      '  "fills": fills,',
      '}))',
    ].join('\n'),
    [file],
  );
  return JSON.parse(out);
}

/**
 * Check the DataMashup length prefix against the package that actually follows it.
 *
 * The mashup blob is `uint32 version | uint32 package_length | package(ZIP) | trailer`.
 * If the prefix is right, `payload[8 : 8+package_length]` is a complete ZIP with nothing
 * left over — its End-Of-Central-Directory record ends exactly at the end of the slice.
 * A stale prefix that overshoots swallows trailer bytes; one that undershoots truncates
 * the ZIP. Excel rejects both, and reports it as a corrupt workbook.
 *
 * inject_m.py's own read-back does NOT catch this: `_split_payload` slices by the declared
 * length and only checks that the slice starts with `PK`, so an overshooting prefix still
 * parses and still prints "M verified". This is the check that closes that gap.
 *
 * @returns {{ declared: number, zipEndsAt: number, slack: number }}
 */
export function mashupPrefix(xlsxFile) {
  const injector = script('py-powerquery-m-diff-inject', 'inject_m.py');
  const out = py(
    [
      'import base64, importlib.util, json, sys, zipfile',
      'spec = importlib.util.spec_from_file_location("inject_m", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'with zipfile.ZipFile(sys.argv[2]) as z:',
      '    text, _ = m._decode_xml(z.read(m.find_mashup_part(z)))',
      'payload = base64.b64decode(m.DATAMASHUP_RE.search(text).group(2))',
      'declared = int.from_bytes(payload[4:8], "little")',
      'pkg = payload[8 : 8 + declared]',
      'eocd = pkg.rfind(b"PK\\x05\\x06")',
      'if eocd < 0:',
      '    print(json.dumps({"declared": declared, "zipEndsAt": -1, "slack": -1}))',
      'else:',
      '    end = eocd + 22 + int.from_bytes(pkg[eocd + 20 : eocd + 22], "little")',
      '    print(json.dumps({"declared": declared, "zipEndsAt": end, "slack": len(pkg) - end}))',
    ].join('\n'),
    [injector, xlsxFile],
  );
  return JSON.parse(out);
}

/** The parts inside an .xlsx (it is a ZIP), as a sorted list of names. */
export function zipParts(file) {
  const r = run('unzip', ['-Z1', file]);
  if (r.code !== 0) throw new Error(`unzip failed: ${r.stderr}`);
  return r.stdout.trim().split('\n').filter(Boolean).sort();
}

/**
 * Rewrite one cell of an emitted changes workbook — the negative control.
 *
 * Used to plant the classic bug (a Removed row carrying the wrong month's values)
 * and prove the verifiers actually reject it. A test suite that only ever feeds
 * verifiers correct input has not tested them.
 */
export function tamperCell(src, dst, { key, status, col, value }) {
  py(
    [
      'import sys,openpyxl',
      'src,dst,key,status,col,value = sys.argv[1:7]',
      'wb=openpyxl.load_workbook(src); ws=wb["Changes"]',
      'hdr=[c.value for c in next(ws.iter_rows(max_row=1))]',
      'ci=hdr.index(col)+1',
      'hit=0',
      'for r in range(2, ws.max_row+1):',
      '    if str(ws.cell(r,2).value)==key and ws.cell(r,3).value==status:',
      '        ws.cell(r,ci).value=value; hit+=1',
      'assert hit==1, f"expected exactly one {status} row for key {key}, found {hit}"',
      'wb.save(dst)',
    ].join('\n'),
    [src, dst, String(key), status, col, value],
  );
  return dst;
}
