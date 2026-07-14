/**
 * Load each skill through the Copilot SDK harness and confirm the output.
 *
 * Mocked by default (no CLI, no network, nothing to install) via the harness's
 * `deps.clientFactory` seam. Run with COPILOT_LIVE=1 to put the same
 * assertions to the real model — the golden answers do not change.
 *
 * What "confirm output" means here, in layers:
 *   1. the skill actually reached the model as the session instruction document
 *   2. the reply parses and validates against the schema (the harness enforces it)
 *   3. the validated value equals the golden — which skills-loader.test.mjs has
 *      already proven is derivable from the skill's own text
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadAllSkills } from './helpers/skills.mjs';
import { skillHarness, scriptFor, LIVE } from './helpers/harness.mjs';
import {
  EXPECTATIONS,
  expectedProbe,
  PROBE_SCHEMA,
  PROBE_QUESTION,
  CONTRACT_SCHEMA,
  CONTRACT_QUESTION,
  CONTRACT_ANSWER,
  CONTRACT_SKILLS,
} from './helpers/expectations.mjs';
import { StructuredOutputError } from '../../vendor/github-copilot-sdk/src/index.mjs';

const skills = loadAllSkills();
const byName = (name) => skills.find((s) => s.name === name);

describe('each skill loads into the harness and yields the expected output', () => {
  for (const skill of skills) {
    test(`${skill.dirName}: loaded as instruction document, structured answer confirmed`, async () => {
      const expected = expectedProbe(skill.name);
      const { harness, ref } = skillHarness({
        skill,
        allSkills: skills,
        script: scriptFor(expected),
      });

      try {
        const { value, attempts } = await harness.structured(PROBE_QUESTION, PROBE_SCHEMA);

        // 3. the model's answer is the golden
        assert.deepEqual(value, expected, `${skill.name} probe answer mismatch`);
        assert.equal(attempts, 1, 'should validate on the first attempt');

        // 1. the skill text really was handed to the model
        if (!LIVE) {
          const cfg = ref.client.lastSessionConfig;
          assert.equal(cfg.systemMessage.mode, 'replace');
          assert.ok(
            cfg.systemMessage.content.includes(`<skill name="${skill.name}">`),
            'skill was not loaded into the session',
          );
          assert.ok(
            cfg.systemMessage.content.includes(skill.body.trim()),
            'skill body was truncated on the way to the model',
          );
          // dependencies ride along, or the skill is unanswerable
          for (const dep of skill.dependencies) {
            assert.ok(
              cfg.systemMessage.content.includes(`<skill name="${dep}">`),
              `dependency ${dep} was not loaded alongside ${skill.name}`,
            );
          }
          // the prompt reached the session verbatim
          assert.match(ref.client.sessions[0].sent[0].prompt, /report the skill under discussion/);
        }

        // the harness accounted for the run
        const summary = harness.usageSummary();
        assert.equal(summary.apiCalls, 1);
        assert.ok(summary.tokens.total > 0);
      } finally {
        await harness.stop();
      }
    });
  }
});

describe('the diff contract survives the round trip', () => {
  for (const name of CONTRACT_SKILLS) {
    test(`${name}: Removed-row / gap / Modified rules answered correctly`, async () => {
      const skill = byName(name);
      const { harness } = skillHarness({
        skill,
        allSkills: skills,
        script: scriptFor(CONTRACT_ANSWER),
      });

      try {
        const { value } = await harness.structured(CONTRACT_QUESTION, CONTRACT_SCHEMA);
        assert.deepEqual(value, CONTRACT_ANSWER);
        // Spelled out, because these are the three ways a plausible-looking
        // diff goes silently wrong:
        assert.equal(value.removedRowValues, 'previous-month', 'a Removed row carries the PREVIOUS month values');
        assert.equal(value.gapBehavior, 'empty-diff', 'a month gap yields an empty diff, not an error');
        assert.equal(value.modifiedDefault, 'opt-in', 'Modified detection is opt-in');
      } finally {
        await harness.stop();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * Harness-contract tests — mocked only. These pin the behavior the
 * suite depends on; against a live model they would be nondeterministic.
 * ------------------------------------------------------------------ */

describe('harness enforces the output contract', { skip: LIVE ? 'mocked-only' : false }, () => {
  const skill = () => byName('py-xlsx-diff-commons');

  test('a fenced ```json reply is still extracted and validated', async () => {
    const expected = expectedProbe('py-xlsx-diff-commons');
    const { harness } = skillHarness({
      skill: skill(),
      allSkills: skills,
      script: scriptFor(expected, { fence: true }),
    });
    const { value } = await harness.structured(PROBE_QUESTION, PROBE_SCHEMA);
    assert.deepEqual(value, expected);
    await harness.stop();
  });

  test('an off-schema answer is rejected, re-asked, and then accepted', async () => {
    const expected = expectedProbe('py-xlsx-diff-commons');
    const { harness, ref } = skillHarness({
      skill: skill(),
      allSkills: skills,
      script: [
        // runtime "perl" is not in the enum, and the entrypoint is invented
        { content: JSON.stringify({ ...expected, runtime: 'perl', entrypoint: 'scripts/nope.rb' }) },
        { content: JSON.stringify(expected) },
      ],
    });

    const invalid = [];
    harness.on('structured:invalid', (e) => invalid.push(e));

    const { value, attempts } = await harness.structured(PROBE_QUESTION, PROBE_SCHEMA);
    assert.deepEqual(value, expected);
    assert.equal(attempts, 2, 'should have taken one repair round');
    assert.equal(invalid.length, 1);

    // the repair prompt told the model what was actually wrong
    const repair = ref.client.sessions[0].sent[1].prompt;
    assert.match(repair, /not valid against the required JSON Schema/);
    assert.match(repair, /runtime/);
    await harness.stop();
  });

  test('a model that never complies fails loudly instead of returning junk', async () => {
    const { harness } = skillHarness({
      skill: skill(),
      allSkills: skills,
      script: [
        { content: 'The engine is xldiff_core.py.' },
        { content: 'Still prose, no JSON.' },
      ],
      config: { structured: { maxRepairAttempts: 1 } },
    });
    await assert.rejects(
      harness.structured(PROBE_QUESTION, PROBE_SCHEMA),
      StructuredOutputError,
    );
    await harness.stop();
  });

  test('a hallucinated entrypoint is caught by the schema pattern', async () => {
    const { harness } = skillHarness({
      skill: skill(),
      allSkills: skills,
      script: [
        { content: JSON.stringify({ ...expectedProbe('py-xlsx-diff-commons'), entrypoint: 'bin/magic' }) },
        { content: JSON.stringify({ ...expectedProbe('py-xlsx-diff-commons'), entrypoint: 'bin/magic' }) },
        { content: JSON.stringify({ ...expectedProbe('py-xlsx-diff-commons'), entrypoint: 'bin/magic' }) },
      ],
    });
    await assert.rejects(harness.structured(PROBE_QUESTION, PROBE_SCHEMA), StructuredOutputError);
    await harness.stop();
  });

  test('loading every skill at once stays within a sane token budget', async () => {
    const { harness } = skillHarness({
      skill: byName('py-xlsx-month-diff'),
      allSkills: skills,
      script: scriptFor(expectedProbe('py-xlsx-month-diff')),
      config: { tokenBudget: { maxTokens: 200_000 } },
    });

    const report = harness.preflight(PROBE_QUESTION, { expectedOutputTokens: 200 });
    assert.equal(report.fitsWithinBudget, true);
    assert.ok(report.estimatedInputTokens > 0);

    const { value } = await harness.structured(PROBE_QUESTION, PROBE_SCHEMA);
    assert.equal(value.skill, 'py-xlsx-month-diff');
    assert.ok(harness.usageSummary().budget.used <= 200_000);
    await harness.stop();
  });

  test('an empty question never reaches the model', async () => {
    const { harness, ref } = skillHarness({
      skill: skill(),
      allSkills: skills,
      script: scriptFor(expectedProbe('py-xlsx-diff-commons')),
    });
    await assert.rejects(harness.structured('   ', PROBE_SCHEMA), /EmptyPrompt|empty/i);
    assert.equal(ref.client, null, 'the CLI runtime should never have started');
    await harness.stop();
  });
});

test('the python and bash suites are declared as twins', () => {
  const py = skills.filter((s) => s.name.startsWith('py-') && s.name !== 'py-powerquery-m-diff-inject');
  const bash = skills.filter((s) => s.name.startsWith('bash-'));
  assert.equal(py.length, bash.length, 'every py- skill except the M-inject one has a bash- twin');

  for (const p of py) {
    const twin = byName(p.name.replace(/^py-/, 'bash-'));
    assert.ok(twin, `${p.name} has no bash twin`);
    assert.equal(
      twin.metadata.role,
      p.metadata.role,
      `${p.name} and ${twin.name} disagree on their role`,
    );
    assert.equal(
      EXPECTATIONS[twin.name].runtime,
      'bash',
      `${twin.name} should be the shell twin`,
    );
  }
});
