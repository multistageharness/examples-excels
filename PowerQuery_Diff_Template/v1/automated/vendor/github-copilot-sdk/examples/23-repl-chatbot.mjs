// 23 — Interactive REPL chatbot over one persistent session.
//
// An onboarding-grade chatbot: a node:readline loop sends each line through
// chat() on a SINGLE live harness/session, so the conversation accumulates
// across turns. Type `exit`/`quit` (or Ctrl-C) to leave; usageReport() prints on
// the way out via runExample's signal-safe shutdown.
//
// NOTE: this example does NOT use requirePrompt — it is interactive by design and
// reads its input from stdin rather than a positional argument.
//
// Run:
//   node examples/23-repl-chatbot.mjs [--cli-path ...] [--model <id>] [--token-budget <n>]
//   printf "What is 2+2?\nexit\n" | node examples/23-repl-chatbot.mjs

import readline from 'node:readline';
import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample } from './_shared.mjs';

const args = parseCommonArgs();
const harness = await createHarness({ config: baseConfig(args) });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'you> ',
});

await runExample(harness, async () => {
  console.error('Interactive chat — type "exit" or "quit" (or Ctrl-C) to leave.');
  rl.prompt();
  for await (const line of rl) {
    const message = line.trim();
    if (!message) {
      rl.prompt();
      continue;
    }
    if (message === 'exit' || message === 'quit') break;
    try {
      const { content } = await harness.chat(message);
      console.log(`bot> ${content}`);
    } catch (err) {
      console.error(`error: ${err.message}`);
    }
    rl.prompt();
  }
  rl.close();
  console.log(`\n${harness.usageReport()}`);
});
