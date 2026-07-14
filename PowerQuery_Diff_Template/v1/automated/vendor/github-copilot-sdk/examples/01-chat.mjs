// 01 — Basic chat with config-driven model + reasoning effort.
//
// Run:
//   node examples/01-chat.mjs [--cli-path /path/to/copilot] [--proxy http://****:*****@proxy:8080]
//   node examples/01-chat.mjs --model gpt-5-mini --effort low "Why is the sky blue?"

import { createHarness } from "../src/index.mjs";
import {
  parseCommonArgs,
  baseConfig,
  runExample,
  requirePrompt,
} from "./_shared.mjs";

const args = parseCommonArgs();
// Require a user message up front: no prompt => print usage and exit before the
// harness (and the CLI runtime) is ever started, so nothing is sent and no
// tokens are spent.
const prompt = requirePrompt(args, 'node examples/01-chat.mjs "your question"');

// Uses the shared standard-usage budget (9k tokens, enforcement 'warn') from
// _shared.mjs. A normal turn is ~10k tokens, so budget:exceeded fires but the
// run still finishes. Override per run with --token-budget / --budget-enforcement.
const harness = await createHarness({
  config: {
    ...baseConfig(args),
    model: "claude-opus-4.6",
  },
});

await runExample(harness, async () => {
  // `response` is the raw Copilot SDK sendAndWait result — exposed here as
  // `$response` so you can see the actual runtime payload. `thinking` is the
  // model's extended reasoning (present only for thinking models like Opus
  // when reasoning effort is engaged); it is null otherwise.
  const {
    content,
    thinking,
    usage,
    sessionId,
    response: $response,
  } = await harness.chat(prompt);

  console.log(content);

  if (thinking) {
    console.log(`\n--- thinking (${thinking.steps.length} step(s)) ---`);
    thinking.steps.forEach((step, i) => console.log(`[${i + 1}] ${step}`));
  } else {
    console.log("\n[no reasoning emitted — model/turn produced no thinking]");
  }

  // The actual Copilot response object behind the answer.
  console.log("\n[$response]");
  console.log(JSON.stringify($response?.data ?? $response, null, 2));

  console.log(
    `\n[session ${sessionId}] ${usage.totalTokens} tokens in ${usage.durationMs}ms`,
  );
});
