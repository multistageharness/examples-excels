/**
 * Golden expectations — one record per skill in `.agents/skills/`.
 *
 * Each record is the answer a model SHOULD give when it has been handed that
 * skill (and its dependencies) as an instruction document. The same record
 * drives two different assertions:
 *
 *   - mocked mode  — the scripted reply is validated against `schema` and
 *     compared to `expected`, proving the harness wired the skill in and
 *     enforced the contract on the way out.
 *   - live mode    — the real model's reply is compared to `expected`.
 *
 * `grounding` is the guard that keeps the goldens honest: every string listed
 * must actually appear in that skill's SKILL.md body. If someone edits a skill
 * and the expected answer stops being derivable from its text, the loader test
 * fails instead of the golden quietly becoming fiction.
 */

/** The shape every probe answer must satisfy. */
export const PROBE_SCHEMA = {
  type: 'object',
  required: ['skill', 'runtime', 'role', 'entrypoint', 'dependencies'],
  additionalProperties: false,
  properties: {
    skill: { type: 'string', minLength: 1 },
    runtime: { type: 'string', enum: ['python', 'bash'] },
    role: {
      type: 'string',
      enum: ['commons', 'entry-point', 'preflight', 'output', 'verification', 'excel-native'],
    },
    // Either a path into the skill's scripts/ dir, or "none" for the
    // documentation-only skills that orchestrate other skills' scripts.
    entrypoint: { type: 'string', pattern: '^(none|scripts/[A-Za-z0-9_.-]+)$' },
    dependencies: { type: 'array', items: { type: 'string' } },
  },
};

/** The question put to the model, given the skill text. */
export const PROBE_QUESTION = [
  'From the skill text alone, report the skill under discussion as JSON.',
  '- runtime: "python" if its scripts are Python, "bash" if they are POSIX shell.',
  '- role: the value of metadata.role.',
  '- entrypoint: the script a caller runs, as "scripts/<file>". Use "none" if the',
  '  skill ships no scripts of its own and only drives other skills\' scripts.',
  '- dependencies: the skills it declares a dependency on (empty array if none).',
].join('\n');

/**
 * The three contract rules from the suite README that are the whole point of
 * the skills — each is a behavior a model must NOT get backwards.
 */
export const CONTRACT_SCHEMA = {
  type: 'object',
  required: ['removedRowValues', 'gapBehavior', 'modifiedDefault'],
  additionalProperties: false,
  properties: {
    // A Removed row carries the PREVIOUS month's values, not the current one.
    removedRowValues: { type: 'string', enum: ['previous-month', 'current-month'] },
    // A month whose predecessor is missing is a base month → empty diff, no error.
    gapBehavior: { type: 'string', enum: ['empty-diff', 'error'] },
    // Modified is opt-in via --detect-modified; default is Unchanged/filtered.
    modifiedDefault: { type: 'string', enum: ['opt-in', 'on-by-default'] },
  },
};

export const CONTRACT_QUESTION = [
  'From the skill text alone, answer these three questions about the diff contract as JSON.',
  '- removedRowValues: does a Removed row carry the "previous-month" values or the "current-month" values?',
  '- gapBehavior: when a month\'s immediate predecessor is absent, does the diff produce an "empty-diff" or an "error"?',
  '- modifiedDefault: is Modified detection "opt-in" or "on-by-default"?',
].join('\n');

/** The correct answer to CONTRACT_QUESTION — see the suite README. */
export const CONTRACT_ANSWER = {
  removedRowValues: 'previous-month',
  gapBehavior: 'empty-diff',
  modifiedDefault: 'opt-in',
};

/**
 * Skills whose text actually states all three contract rules. Only these are
 * probed for the contract — asking a skill a question its text cannot answer
 * would be testing the model's memory, not the skill.
 */
export const CONTRACT_SKILLS = ['py-xlsx-diff-commons', 'py-xlsx-month-diff'];

/** @type {Record<string, {runtime, role, entrypoint, dependencies, grounding}>} */
export const EXPECTATIONS = {
  'bash-xlsx-diff-commons': {
    runtime: 'bash',
    role: 'commons',
    entrypoint: 'scripts/xldiff.sh',
    dependencies: [],
    grounding: ['xlsx2tsv.sh', 'xldiff.sh'],
  },
  'bash-xlsx-diff-export': {
    runtime: 'bash',
    role: 'output',
    entrypoint: 'scripts/write_xlsx.sh',
    dependencies: ['bash-xlsx-diff-commons'],
    grounding: ['write_xlsx.sh', 'tbl_Changes'],
  },
  'bash-xlsx-diff-verify': {
    runtime: 'bash',
    role: 'verification',
    entrypoint: 'scripts/verify.sh',
    dependencies: ['bash-xlsx-diff-commons'],
    grounding: ['verify.sh', 'PARITY', 'INVARIANT'],
  },
  'bash-xlsx-month-diff': {
    runtime: 'bash',
    role: 'entry-point',
    entrypoint: 'none', // orchestrates the other bash- skills' scripts
    dependencies: ['bash-xlsx-diff-commons'],
    grounding: ['inspect.sh', 'xldiff.sh', 'write_xlsx.sh', 'verify.sh'],
  },
  'bash-xlsx-workbook-inspect': {
    runtime: 'bash',
    role: 'preflight',
    entrypoint: 'scripts/inspect.sh',
    dependencies: ['bash-xlsx-diff-commons'],
    grounding: ['inspect.sh', 'base month'],
  },
  'py-powerquery-m-diff-inject': {
    runtime: 'python',
    role: 'excel-native',
    entrypoint: 'scripts/inject_m.py',
    dependencies: [],
    grounding: ['inject_m.py', 'DataMashup', 'Section1.m'],
  },
  'py-xlsx-diff-commons': {
    runtime: 'python',
    role: 'commons',
    entrypoint: 'scripts/xldiff_core.py',
    dependencies: [],
    grounding: ['xldiff_core.py', 'detect-modified', 'previous month', 'base month'],
  },
  'py-xlsx-diff-export': {
    runtime: 'python',
    role: 'output',
    entrypoint: 'none', // the engine in py-xlsx-diff-commons does the writing
    dependencies: ['py-xlsx-diff-commons'],
    grounding: ['xldiff_core.py', 'tbl_Changes'],
  },
  'py-xlsx-diff-verify': {
    runtime: 'python',
    role: 'verification',
    entrypoint: 'scripts/verify_diff.py',
    dependencies: ['py-xlsx-diff-commons'],
    grounding: ['verify_diff.py', 'PARITY', 'INVARIANT'],
  },
  'py-xlsx-month-diff': {
    runtime: 'python',
    role: 'entry-point',
    entrypoint: 'none', // orchestrates inspect / xldiff_core / verify_diff
    dependencies: ['py-xlsx-diff-commons'],
    grounding: ['inspect_workbook.py', 'xldiff_core.py', 'verify_diff.py', 'detect-modified'],
  },
  'py-xlsx-workbook-inspect': {
    runtime: 'python',
    role: 'preflight',
    entrypoint: 'scripts/inspect_workbook.py',
    dependencies: ['py-xlsx-diff-commons'],
    grounding: ['inspect_workbook.py', 'base month'],
  },
  // A documentation/reference skill: prose only, no scripts, no runtime. It is
  // held to the same load + grounding honesty guards as the runnable skills, but
  // is exempt from the runtime/entrypoint probe, which only makes sense for a
  // skill you can execute. Marked `doc: true`; see isDocSkill.
  primitives: {
    doc: true,
    role: 'reference',
    entrypoint: 'none',
    dependencies: ['py-xlsx-diff-commons'],
    grounding: [
      'read_workbook',
      'compare_months',
      'diff_tables',
      'MonthTable',
      'DiffResult',
      'previous month',
      'base month',
    ],
  },
};

/** Documentation/reference skills ship no scripts and are not runtime-probed. */
export const isDocSkill = (name) => Boolean(EXPECTATIONS[name]?.doc);

/** The full expected probe answer for a skill, as the model should return it. */
export function expectedProbe(name) {
  const e = EXPECTATIONS[name];
  if (!e) throw new Error(`no expectation registered for skill "${name}"`);
  return {
    skill: name,
    runtime: e.runtime,
    role: e.role,
    entrypoint: e.entrypoint,
    dependencies: e.dependencies,
  };
}
