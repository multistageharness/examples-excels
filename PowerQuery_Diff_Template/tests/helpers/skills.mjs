/**
 * Skill loader: reads `.agents/skills/<name>/SKILL.md` into structured records.
 *
 * A skill on disk is a markdown file with a YAML frontmatter block. This turns
 * one into { name, description, license, compatibility, metadata, dependencies,
 * body, dir, scripts } so tests can assert on it and so the harness can hand the
 * body to the model as an instruction document.
 *
 * The frontmatter parser deliberately covers only the subset the skill spec
 * uses — top-level scalars, a one-level nested `metadata:` map, and a
 * `dependencies:` list. It is not a general YAML implementation, and it fails
 * loudly rather than guessing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the skills tree under test. */
export const SKILLS_DIR = path.resolve(HERE, '../../.agents/skills');

export class SkillParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkillParseError';
  }
}

function stripQuotes(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Split a SKILL.md into its frontmatter object and its markdown body.
 *
 * @param {string} text raw file contents
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new SkillParseError('SKILL.md must open with a `---` frontmatter fence');
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) {
    throw new SkillParseError('unterminated frontmatter block (no closing `---`)');
  }
  const raw = normalized.slice(4, end + 1);
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1);

  const frontmatter = {};
  let currentKey = null; // the top-level key a nested block/list belongs to

  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const listItem = /^\s+-\s+(.*)$/.exec(line);
    if (listItem) {
      if (!currentKey) throw new SkillParseError(`list item with no parent key: ${line}`);
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(stripQuotes(listItem[1]));
      continue;
    }

    const nested = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (nested) {
      if (!currentKey) throw new SkillParseError(`nested key with no parent: ${line}`);
      if (frontmatter[currentKey] === null || frontmatter[currentKey] === '') frontmatter[currentKey] = {};
      if (typeof frontmatter[currentKey] !== 'object' || Array.isArray(frontmatter[currentKey])) {
        throw new SkillParseError(`cannot nest under scalar key "${currentKey}"`);
      }
      frontmatter[currentKey][nested[1]] = stripQuotes(nested[2]);
      continue;
    }

    // A top-level `key: value` — the value may itself contain colons, so only
    // the FIRST colon separates. An empty value opens a nested block or list.
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!top) throw new SkillParseError(`unparseable frontmatter line: ${line}`);
    currentKey = top[1];
    frontmatter[currentKey] = top[2].trim() === '' ? null : stripQuotes(top[2]);
  }

  return { frontmatter, body };
}

/**
 * Load one skill directory.
 *
 * @param {string} dir absolute path to the skill directory
 */
export function loadSkill(dir) {
  const file = path.join(dir, 'SKILL.md');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new SkillParseError(`cannot read ${file}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    throw new SkillParseError(`${path.basename(dir)}/SKILL.md: ${err.message}`);
  }
  const { frontmatter, body } = parsed;

  const scriptsDir = path.join(dir, 'scripts');
  const scripts = fs.existsSync(scriptsDir)
    ? fs.readdirSync(scriptsDir).filter((f) => !f.startsWith('__') && !f.startsWith('.')).sort()
    : [];

  return {
    name: frontmatter.name,
    description: frontmatter.description ?? null,
    license: frontmatter.license ?? null,
    compatibility: frontmatter.compatibility ?? null,
    metadata: frontmatter.metadata ?? {},
    dependencies: frontmatter.dependencies ?? [],
    frontmatter,
    body,
    raw: text,
    dir,
    dirName: path.basename(dir),
    scripts,
  };
}

/** Load every skill under SKILLS_DIR, sorted by name. */
export function loadAllSkills(root = SKILLS_DIR) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e) => loadSkill(path.join(root, e.name)))
    .sort((a, b) => a.dirName.localeCompare(b.dirName));
}

/**
 * Topologically order skills so every dependency precedes its dependents —
 * the order an agent host would have to load them in.
 *
 * Throws on an unknown dependency or a cycle.
 */
export function resolveLoadOrder(skills) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const ordered = [];
  const state = new Map(); // name -> 'visiting' | 'done'

  const visit = (skill, trail) => {
    const seen = state.get(skill.name);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw new Error(`dependency cycle: ${[...trail, skill.name].join(' -> ')}`);
    }
    state.set(skill.name, 'visiting');
    for (const dep of skill.dependencies) {
      const target = byName.get(dep);
      if (!target) {
        throw new Error(`${skill.name} depends on unknown skill "${dep}"`);
      }
      visit(target, [...trail, skill.name]);
    }
    state.set(skill.name, 'done');
    ordered.push(skill);
  };

  for (const skill of skills) visit(skill, []);
  return ordered;
}

/**
 * Render a skill (and, transitively, the skills it depends on) as the
 * instruction document handed to the model.
 *
 * Dependencies are included because a skill that says "the engine lives in
 * py-xlsx-diff-commons" is not answerable without that skill's text.
 */
export function renderSkillPrompt(skill, allSkills = []) {
  const byName = new Map(allSkills.map((s) => [s.name, s]));
  const chain = [];
  const push = (s) => {
    if (chain.some((c) => c.name === s.name)) return;
    for (const dep of s.dependencies) {
      const target = byName.get(dep);
      if (target) push(target);
    }
    chain.push(s);
  };
  push(skill);

  const sections = chain.map(
    (s) => `<skill name="${s.name}">\n${s.body.trim()}\n</skill>`,
  );
  return [
    'You are answering questions about the agent skills below.',
    'Answer ONLY from the skill text. Do not invent scripts, flags, or behavior.',
    '',
    ...sections,
  ].join('\n');
}
