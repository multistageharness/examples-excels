// 10 — Instruction document via systemPromptFile + systemPromptMode.
//
// The harness can load an instruction document with `systemPromptFile` and
// control how it lands in the system message with `systemPromptMode`:
//   - 'append'  : add the instructions on top of the CLI's own system prompt
//   - 'replace' : swap the system prompt out for the instruction doc wholesale
// Same file, same user prompt — only the mode differs, so the two replies make
// the behavioral difference visible.
//
// Run:
//   node examples/10-system-prompt.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/10-system-prompt.mjs --model gpt-5-mini --effort low "How do I restart the billing service in prod?"

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No prompt => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/10-system-prompt.mjs "How do I restart the billing service in prod?"');

const SYSTEM_PROMPT_FILE = 'examples/instructions.example.md';

// The 'append' harness is the primary one runExample manages (signal-safe stop);
// the 'replace' harness is created inside and stopped in its own finally.
const appendHarness = await createHarness({
  config: baseConfig(args, { systemPromptFile: SYSTEM_PROMPT_FILE, systemPromptMode: 'append' }),
});

await runExample(appendHarness, async () => {
  const append = await appendHarness.chat(prompt);

  const replaceHarness = await createHarness({
    config: baseConfig(args, { systemPromptFile: SYSTEM_PROMPT_FILE, systemPromptMode: 'replace' }),
  });
  let replace;
  try {
    replace = await replaceHarness.chat(prompt);
  } finally {
    await replaceHarness.stop();
  }

  console.log('=== systemPromptMode: append (instructions added on top) ===');
  console.log(append.content);
  console.log('\n=== systemPromptMode: replace (instructions swapped in) ===');
  console.log(replace.content);
  console.log(
    `\n[append ${append.usage.totalTokens} tok | replace ${replace.usage.totalTokens} tok]`,
  );
});
