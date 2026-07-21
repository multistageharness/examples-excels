// 06 — Token budget: pre-run analysis, enforcement, usage summary.
//
// Shows the three budget surfaces:
//   1. harness.preflight()  — token usage analysis BEFORE any run
//   2. budget enforcement   — block (throw) or warn when the ceiling is hit
//   3. harness.usageReport() — tokens/tools/skills summary after runs
//
// Run:
//   node examples/06-token-budget.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/06-token-budget.mjs --model gpt-5-mini --effort low "Summarize the SRE golden signals in 3 bullets."

import { createHarness, TokenBudgetExceededError } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No message => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/06-token-budget.mjs "Summarize the SRE golden signals in 3 bullets."');
const harness = await createHarness({
  config: baseConfig(args, {
    tokenBudget: { maxTokens: 2_000, warnAtPercent: 50, enforcement: 'block' },
  }),
});

harness.on('budget:warn', (b) => console.error(`[budget] ${b.utilizationPercent}% used`));
harness.on('budget:exceeded', (b) => console.error(`[budget] EXCEEDED: ${b.used}/${b.maxTokens}`));

await runExample(harness, async () => {
  // 1. Analyze before running.
  const analysis = harness.preflight(prompt, { expectedOutputTokens: 150 });
  console.log('preflight:', JSON.stringify(analysis, null, 2));
  if (!analysis.fitsWithinBudget) {
    console.error('would not fit budget — aborting');
    return;
  }

  // 2. Run within budget.
  const { content } = await harness.chat(prompt);
  console.log(content);

  // 3. Demonstrate the block: a prompt the remaining budget can't cover.
  try {
    await harness.chat('x'.repeat(40_000));
  } catch (err) {
    if (err instanceof TokenBudgetExceededError) {
      console.error(`blocked as expected: ${err.message}`);
    } else {
      throw err;
    }
  }

  console.log(`\n${harness.usageReport()}`);
});
