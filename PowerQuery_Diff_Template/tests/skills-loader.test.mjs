/**
 * Skill-tree tests — no model involved.
 *
 * These check that what is on disk is loadable and internally consistent, and
 * that the goldens in expectations.mjs are still derivable from the skill text.
 * If these fail, the harness tests would be testing fiction.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadAllSkills, resolveLoadOrder, parseFrontmatter, SkillParseError, SKILLS_DIR } from './helpers/skills.mjs';
import { EXPECTATIONS, expectedProbe, PROBE_SCHEMA, CONTRACT_SKILLS, isDocSkill } from './helpers/expectations.mjs';
import { validateSchema } from '../vendor/github-copilot-sdk/src/structured.mjs';

const skills = loadAllSkills();

test('every skill directory under .agents/skills loads', () => {
  const onDisk = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  assert.equal(skills.length, onDisk.length, 'a skill directory failed to load');
  assert.deepEqual(skills.map((s) => s.dirName), onDisk);
  assert.ok(skills.length > 0, 'no skills found');
});

test('every skill has an expectation, and every expectation has a skill', () => {
  const loaded = skills.map((s) => s.name).sort();
  const expected = Object.keys(EXPECTATIONS).sort();
  assert.deepEqual(loaded, expected, 'goldens and skills tree have drifted apart');
});

describe('frontmatter contract', () => {
  for (const skill of skills) {
    test(`${skill.dirName}: frontmatter is well-formed`, () => {
      assert.equal(skill.name, skill.dirName, 'frontmatter name must match its directory');
      assert.ok(skill.description?.length > 40, 'description must be substantive');
      assert.equal(skill.license, 'MIT');
      assert.ok(skill.compatibility, 'compatibility must be declared');
      assert.ok(skill.metadata.role, 'metadata.role must be declared');
      assert.ok(skill.body.trim().length > 200, 'body must not be a stub');
      assert.ok(Array.isArray(skill.dependencies));
    });
  }
});

describe('dependency graph', () => {
  test('every declared dependency resolves and the graph is acyclic', () => {
    const order = resolveLoadOrder(skills); // throws on unknown dep or cycle
    assert.equal(order.length, skills.length);

    // A dependency must appear before the skill that needs it.
    const position = new Map(order.map((s, i) => [s.name, i]));
    for (const skill of skills) {
      for (const dep of skill.dependencies) {
        assert.ok(
          position.get(dep) < position.get(skill.name),
          `${dep} must load before ${skill.name}`,
        );
      }
    }
  });

  test('declared dependencies match the goldens', () => {
    for (const skill of skills) {
      assert.deepEqual(
        skill.dependencies,
        EXPECTATIONS[skill.name].dependencies,
        `${skill.name} dependencies drifted`,
      );
    }
  });

  test('the two commons skills are the only roots', () => {
    const roots = skills.filter((s) => s.dependencies.length === 0).map((s) => s.name).sort();
    assert.deepEqual(roots, [
      'bash-xlsx-diff-commons',
      'py-powerquery-m-diff-inject', // the road not taken: depends on nothing
      'py-xlsx-diff-commons',
    ]);
  });
});

describe('goldens are grounded in the skill text', () => {
  for (const skill of skills) {
    const golden = EXPECTATIONS[skill.name];

    test(`${skill.dirName}: every grounding phrase appears in SKILL.md`, () => {
      for (const phrase of golden.grounding) {
        assert.ok(
          skill.body.includes(phrase),
          `"${phrase}" is no longer in ${skill.name}/SKILL.md — the golden is now fiction`,
        );
      }
    });

    test(`${skill.dirName}: metadata.role matches the golden`, () => {
      assert.equal(skill.metadata.role, golden.role);
    });

    test(`${skill.dirName}: the golden entrypoint exists on disk`, () => {
      if (golden.entrypoint === 'none') {
        assert.equal(skill.scripts.length, 0, `${skill.name} ships scripts but the golden says "none"`);
        return;
      }
      const abs = path.join(skill.dir, golden.entrypoint);
      assert.ok(fs.existsSync(abs), `${golden.entrypoint} does not exist in ${skill.name}`);
      assert.ok(skill.scripts.includes(path.basename(golden.entrypoint)));
    });

    test(`${skill.dirName}: the expected probe answer satisfies the schema`, {
      skip: isDocSkill(skill.name) ? 'reference skill: not runtime-probed' : false,
    }, () => {
      const { valid, errors } = validateSchema(expectedProbe(skill.name), PROBE_SCHEMA);
      assert.ok(valid, `golden violates PROBE_SCHEMA: ${errors.join('; ')}`);
    });
  }
});

test('the contract-probe skills actually state all three contract rules', () => {
  for (const name of CONTRACT_SKILLS) {
    const skill = skills.find((s) => s.name === name);
    assert.ok(skill, `${name} not found`);
    assert.match(skill.body, /previous month|last seen|last \*seen\*/i, `${name} must state the Removed-row rule`);
    assert.match(skill.body, /base month/i, `${name} must state the gap rule`);
    assert.match(skill.body, /detect-modified/, `${name} must state the Modified opt-in`);
  }
});

describe('frontmatter parser', () => {
  test('parses scalars, nested maps, and lists', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nname: x\ndescription: has: colons, and commas\nmetadata:\n  role: commons\ndependencies:\n  - a\n  - b\n---\n# Body\ntext\n',
    );
    assert.equal(frontmatter.name, 'x');
    assert.equal(frontmatter.description, 'has: colons, and commas');
    assert.deepEqual(frontmatter.metadata, { role: 'commons' });
    assert.deepEqual(frontmatter.dependencies, ['a', 'b']);
    assert.match(body, /^# Body/);
  });

  test('rejects a file with no frontmatter fence', () => {
    assert.throws(() => parseFrontmatter('# Just markdown\n'), SkillParseError);
  });

  test('rejects an unterminated frontmatter block', () => {
    assert.throws(() => parseFrontmatter('---\nname: x\n'), SkillParseError);
  });
});
