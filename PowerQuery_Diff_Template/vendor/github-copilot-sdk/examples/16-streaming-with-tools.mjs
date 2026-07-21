// 16 — Streaming + tool calling in one turn.
//
// 02-streaming.mjs streams deltas; 05-tool-calling.mjs registers tools. This
// combines them: the model calls a registered tool mid-turn while we iterate the
// streamed assistant deltas. The tool:call / tool:result events fire during the
// stream, so you can watch the tool run before the final text arrives.
//
// Run:
//   node examples/16-streaming-with-tools.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/16-streaming-with-tools.mjs --model gpt-5-mini --effort low "What's the weather in Tokyo? Summarize it in a sentence."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No prompt => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(
  args,
  `node examples/16-streaming-with-tools.mjs "What's the weather in Tokyo? Summarize it in a sentence."`,
);
const harness = await createHarness({ config: baseConfig(args, { streaming: true }) });

// A tool the prompt should induce the model to call mid-stream.
harness.registerTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    required: ['city'],
    properties: { city: { type: 'string', description: 'City name, e.g. "Tokyo"' } },
  },
  handler: ({ city }) => {
    const forecast = { Tokyo: '18°C, light rain', Cairo: '33°C, sunny' };
    return forecast[city] ?? `20°C, partly cloudy (no data for ${city})`;
  },
});

// Watch the tool fire DURING the stream.
harness.on('tool:call', ({ tool, args: callArgs }) =>
  console.error(`\n  → tool ${tool}(${JSON.stringify(callArgs)})`));
harness.on('tool:result', ({ tool, result }) =>
  console.error(`  ← tool ${tool} returned ${JSON.stringify(result)}`));

await runExample(harness, async () => {
  for await (const item of harness.stream(prompt)) {
    if (item.type === 'delta') {
      process.stdout.write(item.content);
    } else if (item.type === 'message') {
      process.stdout.write(`\n\n[done] ${item.usage.totalTokens} tokens\n`);
    }
  }
});
