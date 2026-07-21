// 07 — Session persistence: context store + attach/continue conversations.
//
// Every request/response is persisted as JSONL under the configured
// directory. `continueFrom(sessionId)` resumes the CLI-side session when it
// still exists, and otherwise replays the stored context window into a
// fresh session — so conversations survive process restarts either way.
//
// Run twice to see the continuation:
//   node examples/07-session-persistence.mjs "My favorite number is 41."
//   node examples/07-session-persistence.mjs --continue "What is my favorite number plus one?"

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const rawArgs = process.argv.slice(2);
const continueLast = rawArgs.includes('--continue');
const args = parseCommonArgs(rawArgs.filter((a) => a !== '--continue'));

// No message => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/07-session-persistence.mjs [--continue] "your message"');

const harness = await createHarness({
  config: baseConfig(args, {
    contextStore: { enabled: true, directory: '.copilot-harness/context' },
  }),
});

await runExample(harness, async () => {
  if (continueLast) {
    const lastId = harness.store.latestSessionId();
    if (!lastId) {
      console.error('no stored session found — run without --continue first');
      return;
    }
    console.error(`[continuing from stored session ${lastId}]`);
    await harness.continueFrom(lastId);
  }

  const { content, sessionId } = await harness.chat(prompt);
  console.log(content);
  console.error(`\n[session ${sessionId} persisted to ${harness.store.directory}]`);
});
