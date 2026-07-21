// 12 — Resume a conversation: resumeSession() vs continueFrom().
//
// The harness offers two restore paths:
//   - resumeSession(id) : CLI-side resume of a still-live session; throws if the
//                         session no longer exists.
//   - continueFrom(id)  : resume if alive, else REPLAY the stored context window
//                         from the on-disk ContextStore into a fresh session.
// contextStore.enabled is required for the replay fallback to have anything to
// replay. (07-session-persistence.mjs only shows the --continue flag; this
// example contrasts the two primitives directly.)
//
// Run:
//   node examples/12-resume-session.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/12-resume-session.mjs --model gpt-5-mini --effort low "My favorite number is 41."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No prompt => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/12-resume-session.mjs "My favorite number is 41."');
const harness = await createHarness({
  config: baseConfig(args, {
    contextStore: { enabled: true, directory: '.copilot-harness/context' },
  }),
});

const FOLLOW_UP = 'What is my favorite number plus one?';

await runExample(harness, async () => {
  // Turn 1: establish a session and capture its id.
  const first = await harness.chat(prompt);
  const sessionId = first.sessionId;
  console.log(`[turn 1 @ session ${sessionId}] ${first.content}`);

  // Path A — resumeSession(id): re-attach to the live CLI session. Throws if the
  // session is gone (e.g. after a runtime restart); caught here for the demo.
  try {
    await harness.resumeSession(sessionId);
    console.error(`[resumeSession] re-attached to live CLI session ${sessionId}`);
  } catch (err) {
    console.error(`[resumeSession] session not live (${err.message}) — would need continueFrom`);
  }

  // Path B — continueFrom(id): resume if alive, otherwise replay the stored
  // context window into a new session. Works either way thanks to the store.
  await harness.continueFrom(sessionId);
  const second = await harness.chat(FOLLOW_UP);
  console.log(`[turn 2] ${second.content}`);
  console.error(`\n[context persisted under ${harness.store.directory}]`);
});
