// 05 — Tool calling: let the model call your code.
//
// The flow is three steps:
//   1. registerTool(...)  — describe a function the model is allowed to call.
//   2. harness.chat(...)  — ask a question that needs it.
//   3. the SDK calls your handler, feeds the result back to the model, and the
//      model writes its final answer using what your tool returned.
//
// You never call the tools yourself — the model decides when (and with what
// arguments) to call them, based on each tool's `description` and `parameters`.
//
// Run:
//   node examples/05-tool-calling.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/05-tool-calling.mjs --model gpt-5-mini --effort low "What's the weather in Tokyo and in Cairo?"

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No message => print usage and exit before starting the runtime (0 tokens).
// Try a prompt that needs BOTH tools, e.g. the one in the usage hint — awkward
// numbers nudge the model toward the `add` tool instead of mental math.
const prompt = requirePrompt(
  args,
  `node examples/05-tool-calling.mjs "What's the weather in Tokyo and Cairo? Also total 48217, 19377 and 6655."`,
);
const harness = await createHarness({ config: baseConfig(args) });

// --- Tool 1: a lookup. ------------------------------------------------------
// `parameters` is a JSON Schema describing the arguments the model must supply.
// The model fills these in; they arrive as the first argument to `handler`.
harness.registerTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    required: ['city'],
    properties: {
      city: { type: 'string', description: 'City name, e.g. "Tokyo"' },
    },
  },
  // A handler may return a plain string — the SDK passes it back to the model.
  handler: ({ city }) => {
    const fakeForecast = { Tokyo: '18°C, light rain', Cairo: '33°C, sunny' };
    return fakeForecast[city] ?? `20°C, partly cloudy (no data for ${city})`;
  },
});

// --- Tool 2: a calculation. -------------------------------------------------
harness.registerTool({
  name: 'add',
  description: 'Add a list of numbers together.',
  parameters: {
    type: 'object',
    required: ['numbers'],
    properties: { numbers: { type: 'array', items: { type: 'number' } } },
  },
  handler: ({ numbers }) => String(numbers.reduce((sum, n) => sum + n, 0)),
});

// Optional: watch the model reach for each tool, so you can see it happen.
harness.on('tool:call', ({ tool, args: callArgs }) =>
  console.error(`  → model called ${tool}(${JSON.stringify(callArgs)})`));

await runExample(harness, async () => {
  // The model picks each registered tool on its own based on the prompt.
  const { content } = await harness.chat(prompt);
  console.log(`\n${content}`);
});
