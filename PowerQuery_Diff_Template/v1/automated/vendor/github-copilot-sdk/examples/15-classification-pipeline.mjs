// 15 — Batch classification pipeline + usage rollup.
//
// A batch pattern: classify many inputs into a fixed enum schema via
// structured() in a loop on ONE harness instance, tally the labels, and print a
// usageReport() covering every call in the batch. The prompt arg is the shared
// classification instruction; the items come from a built-in fixture list.
//
// Run:
//   node examples/15-classification-pipeline.mjs [--cli-path ...] [--model <id>] ["instruction"]
//   node examples/15-classification-pipeline.mjs --model gpt-5-mini --effort low "Classify each message into a support category."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No instruction => print usage and exit before starting the runtime (0 tokens).
const instruction = requirePrompt(args, 'node examples/15-classification-pipeline.mjs "Classify each message into a support category."');
const harness = await createHarness({ config: baseConfig(args) });

// The batch of inputs to classify (stand-in for a queue/dataset).
const FIXTURES = [
  'My invoice was charged twice this month.',
  'How do I reset my password?',
  'The dashboard has been down for an hour!',
  'Can you add a dark mode to the settings page?',
];

const SCHEMA = {
  type: 'object',
  required: ['label'],
  additionalProperties: false,
  properties: {
    label: { enum: ['billing', 'account', 'outage', 'feature-request', 'other'] },
  },
};

await runExample(harness, async () => {
  const tally = {};
  for (const text of FIXTURES) {
    const { value } = await harness.structured(instruction, SCHEMA, {
      input: { text },
      inputLabel: 'message',
    });
    tally[value.label] = (tally[value.label] ?? 0) + 1;
    console.log(`  ${value.label.padEnd(16)} ${text}`);
  }

  console.log('\nLabel tally:');
  for (const [label, count] of Object.entries(tally)) {
    console.log(`  ${label}: ${count}`);
  }
  console.log(`\n${harness.usageReport()}`);
});
