// 02 — Streaming chat: deltas printed as they arrive.
//
// The harness exposes streaming as an async iterator; under the hood it
// subscribes to the SDK's `assistant.message_delta` events (the CLI's SSE
// stream surfaced as typed events).
//
// Run:
//   node examples/02-streaming.mjs [--cli-path ...] [--proxy ...] [--model <id>] [--token-budget <n>]
//   node examples/02-streaming.mjs --model gpt-5-mini --effort low "Write a haiku about garbage collection in JavaScript."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No message => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/02-streaming.mjs "your prompt"');
const harness = await createHarness({ config: baseConfig(args, { streaming: true }) });

await runExample(harness, async () => {
  for await (const item of harness.stream(prompt)) {
    if (item.type === 'delta') {
      process.stdout.write(item.content);
    } else if (item.type === 'message') {
      process.stdout.write(`\n\n[done] ${item.usage.totalTokens} tokens\n`);
    }
  }
});
