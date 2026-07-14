// 22 — Built-in MCPs + sessionDefaults + a bridged SDK hook.
//
// baseConfig defaults cliArgs to ['--disable-builtin-mcps'] to keep the other
// examples on the bare SDK surface. This example deliberately does the opposite:
//   - overrides cliArgs (does NOT inherit --disable-builtin-mcps) so the
//     runtime's built-in MCP servers/tools stay enabled,
//   - sets a sessionDefaults value (an escape-hatch forwarded verbatim into the
//     SDK session config), and
//   - registers a `beforeToolCall` hook — which the harness bridges to the SDK's
//     onPreToolUse — so it fires for BUILT-IN tools too, not just registerTool().
//
// DEMO-GRADE: needs a live, authenticated Copilot CLI to fully run. The
// no-prompt usage guard below exits before the runtime is ever spawned.
//
// Run:
//   node examples/22-mcp-and-builtins.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/22-mcp-and-builtins.mjs --model gpt-5-mini --effort low "List the files in the current directory."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No prompt => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/22-mcp-and-builtins.mjs "List the files in the current directory."');

const harness = await createHarness({
  config: baseConfig(args, {
    // Override: empty cliArgs keeps the runtime's built-in MCP servers ENABLED
    // (we drop the --disable-builtin-mcps default the other examples carry).
    cliArgs: [],
    // Escape hatch: spread verbatim into the SDK session config (see
    // _buildSessionConfig). Use it for SDK session fields the harness doesn't
    // surface directly.
    sessionDefaults: { allowAllTools: true },
  }),
  hooks: {
    // Bridged from SDK onPreToolUse -> harness beforeToolCall, so this also runs
    // for built-in / MCP tools the model invokes (return { deny } to block).
    beforeToolCall: ({ toolName, args: toolArgs }) => {
      console.error(`[onPreToolUse→beforeToolCall] built-in/MCP tool: ${toolName}(${JSON.stringify(toolArgs)})`);
      return undefined; // allow
    },
  },
});

harness.on('tool:start', ({ tool }) => console.error(`[event tool:start] ${tool}`));

await runExample(harness, async () => {
  const { content } = await harness.chat(prompt);
  console.log(content);
});
