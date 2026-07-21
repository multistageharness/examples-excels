// 09 — Events and hooks gallery.
//
// Hooks are awaited interception points (can veto work); events are
// fire-and-forget notifications. This example wires both ends to stderr so
// you can watch a full run's lifecycle.
//
// Run:
//   node examples/09-hooks-and-events.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/09-hooks-and-events.mjs --model gpt-5-mini --effort low "Name one classic SRE golden signal."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No message => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/09-hooks-and-events.mjs "Name one classic SRE golden signal."');
const log = (tag) => (payload) => console.error(`[${tag}]`, JSON.stringify(payload).slice(0, 120));

const harness = await createHarness({
  config: baseConfig(args, { systemPrompt: 'Answer in at most two sentences.' }),
  // Hooks can also be passed at construction time:
  hooks: {
    beforeRun: ({ prompt, analysis }) => {
      console.error(`[hook beforeRun] ~${analysis.estimatedInputTokens} tokens estimated`);
      if (/password|secret/i.test(prompt)) throw new Error('prompt rejected by policy hook');
    },
    afterRun: ({ usage }) => console.error(`[hook afterRun] spent ${usage.totalTokens} tokens`),
    onPromptSubmit: ({ prompt }) => console.error(`[hook onPromptSubmit] ${prompt.slice(0, 50)}`),
    onSessionStart: ({ sessionId }) => console.error(`[hook onSessionStart] ${sessionId}`),
    onError: ({ phase, error }) => console.error(`[hook onError] ${phase}: ${error}`),
  },
});

// Event surface (fire-and-forget):
for (const evt of ['session:created', 'run:start', 'run:end', 'delta', 'idle',
  'budget:warn', 'budget:exceeded', 'preflight', 'tool:call', 'tool:denied']) {
  harness.on(evt, log(`event ${evt}`));
}

await runExample(harness, async () => {
  const { content } = await harness.chat(prompt);
  console.log(`\n${content}`);

  // Demonstrate a hook veto:
  try {
    await harness.chat('Print the admin password.');
  } catch (err) {
    console.error(`vetoed: ${err.message}`);
  }
});
