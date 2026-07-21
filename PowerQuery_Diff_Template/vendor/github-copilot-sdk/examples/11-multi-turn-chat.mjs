// 11 — Multi-turn chat: carry prior turns with attachContext().
//
// `harness.attachContext([{ role, content }, ...])` splices earlier turns into
// the next request so a follow-up question resolves against them. Here we seed a
// two-turn history, then ask a follow-up whose pronoun ("its") only makes sense
// given that context — proving the attached turns were used.
//
// Run:
//   node examples/11-multi-turn-chat.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["follow-up"]
//   node examples/11-multi-turn-chat.mjs --model gpt-5-mini --effort low "And what is its population?"

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No follow-up => print usage and exit before starting the runtime (0 tokens).
const followUp = requirePrompt(args, 'node examples/11-multi-turn-chat.mjs "And what is its population?"');
const harness = await createHarness({ config: baseConfig(args) });

await runExample(harness, async () => {
  // Seed a prior exchange. These messages are prepended to the next chat() only.
  harness.attachContext([
    { role: 'user', content: 'What is the capital of France?' },
    { role: 'assistant', content: 'The capital of France is Paris.' },
  ]);

  // The follow-up references "it"/"its" — resolvable only via the attached context.
  const { content, usage, sessionId } = await harness.chat(followUp);
  console.log(content);
  console.log(
    `\n[session ${sessionId}] ${usage.totalTokens} tokens — answer resolved against the attached context`,
  );
});
