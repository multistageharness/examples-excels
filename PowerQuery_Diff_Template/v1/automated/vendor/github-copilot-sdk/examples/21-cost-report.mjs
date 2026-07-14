// 21 — Cost / observability report from a mixed workload.
//
// usageSummary() (structured) and usageReport() (rendered) expose per-model and
// per-tool stats, token splits, and latency percentiles. This runs a small mixed
// workload — a couple of chat() calls plus a tool call — then renders both, so
// you can see the breakdowns a cost dashboard would chart.
//
// Run:
//   node examples/21-cost-report.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/21-cost-report.mjs --model gpt-5-mini --effort low "Explain the SRE golden signals."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No prompt => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/21-cost-report.mjs "Explain the SRE golden signals."');
const harness = await createHarness({ config: baseConfig(args) });

// A tool so the report shows a per-tool breakdown too.
harness.registerTool({
  name: 'word_count',
  description: 'Count the words in a piece of text.',
  parameters: {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  handler: ({ text }) => String(String(text).trim().split(/\s+/).filter(Boolean).length),
});

await runExample(harness, async () => {
  // Mixed workload: two chats + a prompt that should use the tool.
  await harness.chat(prompt);
  await harness.chat('Now summarize that in a single sentence.');
  await harness.chat(`Use the word_count tool to count the words in: "${prompt}"`);

  const summary = harness.usageSummary();
  console.log('=== usageSummary() (structured) ===');
  console.log(JSON.stringify(summary, null, 2));

  console.log('\n=== usageReport() (rendered) ===');
  console.log(harness.usageReport());
});
