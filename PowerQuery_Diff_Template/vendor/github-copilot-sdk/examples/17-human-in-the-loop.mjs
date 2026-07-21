// 17 — Human-in-the-loop: interactive tool approval via beforeToolCall.
//
// 09-hooks-and-events.mjs shows a static policy veto. This makes the decision
// interactive: a `beforeToolCall` hook prompts the operator at the terminal for
// each tool call and returns `{ deny: true, reason }` on rejection. A denied
// call emits `tool:denied` and the model receives a structured failure (the run
// continues — it does not crash).
//
// Run:
//   node examples/17-human-in-the-loop.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/17-human-in-the-loop.mjs --model gpt-5-mini --effort low "Delete the file /tmp/report.csv"

import readline from 'node:readline';
import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No prompt => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/17-human-in-the-loop.mjs "Delete the file /tmp/report.csv"');

// Ask the operator y/N on stderr so it never mixes with the model's stdout.
function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const harness = await createHarness({
  config: baseConfig(args),
  hooks: {
    // Awaited interception point — return { deny, reason } to block the call.
    beforeToolCall: async ({ toolName, args: toolArgs }) => {
      const approved = await askYesNo(`Allow tool ${toolName}(${JSON.stringify(toolArgs)})? [y/N] `);
      if (!approved) return { deny: true, reason: 'operator denied the tool call' };
      return undefined; // allow
    },
  },
});

harness.registerTool({
  name: 'delete_file',
  description: 'Delete a file at the given path.',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string', description: 'absolute file path' } },
  },
  // Stubbed — the point of the example is the approval gate, not real deletion.
  handler: ({ path }) => `deleted ${path}`,
});

harness.on('tool:denied', ({ tool, reason }) => console.error(`[tool:denied] ${tool}: ${reason}`));

await runExample(harness, async () => {
  const { content } = await harness.chat(prompt);
  console.log(`\n${content}`);
});
