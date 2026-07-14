/**
 * Binds a skill to the vendored Copilot harness.
 *
 * Two modes, one code path:
 *
 *   - mocked (default) — the harness's `deps.clientFactory` seam is filled with
 *     the SDK's MockClient, so no Copilot CLI is spawned, no network is touched,
 *     and no npm package needs installing. `@github/copilot-sdk` is imported
 *     lazily by the harness and only when that seam is absent.
 *   - live (COPILOT_LIVE=1) — the real client, talking to the real model.
 *
 * The skill is loaded the way an agent host loads one: as the session's system
 * prompt / instruction document.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CopilotHarness } from '../../../vendor/github-copilot-sdk/src/index.mjs';
import { mockDeps } from '../../../vendor/github-copilot-sdk/test/helpers/mock-sdk.mjs';
import { renderSkillPrompt } from './skills.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SDK_DIR = path.resolve(HERE, '../../../vendor/github-copilot-sdk');

/** Live mode runs against the real Copilot model; off unless explicitly asked for. */
export const LIVE = process.env.COPILOT_LIVE === '1';

/**
 * A harness with `skill` loaded as its instruction document.
 *
 * @param {object} opts
 * @param {object} opts.skill      the skill under test
 * @param {object[]} [opts.allSkills] full set, so dependencies come along
 * @param {Array|Function} [opts.script] mock reply script (ignored in live mode)
 * @param {object} [opts.config]   harness config overrides
 * @returns {{ harness: CopilotHarness, ref: {client: object|null}, systemPrompt: string }}
 */
export function skillHarness({ skill, allSkills = [], script, config = {} } = {}) {
  const systemPrompt = renderSkillPrompt(skill, allSkills);
  const options = {
    config: {
      model: 'gpt-5-mini',
      reasoningEffort: 'low',
      systemPrompt,
      systemPromptMode: 'replace',
      ...config,
    },
  };

  if (LIVE) {
    return { harness: new CopilotHarness(options), ref: { client: null }, systemPrompt };
  }

  const { deps, ref } = mockDeps({ script });
  return { harness: new CopilotHarness(options, deps), ref, systemPrompt };
}

/**
 * Turn an expected answer object into a mock reply script step. In live mode the
 * script is unused — the model produces the reply itself — so this is what makes
 * the same test body work against both.
 */
export function scriptFor(expected, { fence = false } = {}) {
  const json = JSON.stringify(expected);
  return [{ content: fence ? `\`\`\`json\n${json}\n\`\`\`` : json, inputTokens: 40, outputTokens: 20 }];
}
