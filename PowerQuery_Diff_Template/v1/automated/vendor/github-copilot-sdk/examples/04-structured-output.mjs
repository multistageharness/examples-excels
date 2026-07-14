// 04 — Structured input + structured output against a JSON Schema.
//
// The harness embeds the schema in the prompt, extracts JSON from the
// reply, validates it locally, and auto-repairs (re-asks with the
// validation errors) up to `structured.maxRepairAttempts` times.
//
// Run:
//   node examples/04-structured-output.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/04-structured-output.mjs --model gpt-5-mini --effort low "Analyze this code snippet."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No task message => print usage and exit before starting the runtime (0 tokens).
const task = requirePrompt(args, 'node examples/04-structured-output.mjs "Analyze this code snippet."');
const harness = await createHarness({ config: baseConfig(args) });

const SCHEMA = {
  type: 'object',
  required: ['language', 'complexity', 'summary', 'risks'],
  additionalProperties: false,
  properties: {
    language: { type: 'string' },
    complexity: { enum: ['low', 'medium', 'high'] },
    summary: { type: 'string', maxLength: 280 },
    risks: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
};

await runExample(harness, async () => {
  const { value, attempts, usage } = await harness.structured(
    task,
    SCHEMA,
    {
      input: {
        filename: 'cache.mjs',
        code: 'const cache = {}; export const get = (k) => cache[k]; export const put = (k, v) => { cache[k] = v; };',
      },
      inputLabel: 'code-snippet',
    },
  );
  console.log(JSON.stringify(value, null, 2));
  console.log(`\n[${attempts} attempt(s), ${usage.totalTokens} tokens]`);
});
