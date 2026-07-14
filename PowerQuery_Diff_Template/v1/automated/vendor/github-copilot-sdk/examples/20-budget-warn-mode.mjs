// 20 — Token budget: 'warn' vs 'block' enforcement.
//
// 06/06a/06b show budget BLOCK behavior. This example contrasts the two
// enforcement modes against the same prompt and a deliberately tiny budget:
//   - 'warn'  : proceeds past the ceiling, emits budget:warn / budget:exceeded,
//               and the run still completes.
//   - 'block' : throws TokenBudgetExceededError BEFORE anything is sent.
//
// Run:
//   node examples/20-budget-warn-mode.mjs [--cli-path ...] [--model <id>] ["prompt"]
//   node examples/20-budget-warn-mode.mjs --model gpt-5-mini --effort low "Summarize the SRE golden signals in 3 bullets."

import { createHarness, TokenBudgetExceededError } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No prompt => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/20-budget-warn-mode.mjs "Summarize the SRE golden signals in 3 bullets."');

// Tiny ceiling so a normal turn (~10k tokens) trips it in BOTH modes.
const BUDGET = { maxTokens: 2_000, warnAtPercent: 50 };

function wireBudgetEvents(harness, label) {
  harness.on('budget:warn', (b) => console.error(`[${label}] budget:warn ${b.utilizationPercent}% used`));
  harness.on('budget:exceeded', (b) => console.error(`[${label}] budget:exceeded ${b.used}/${b.maxTokens}`));
}

const warnHarness = await createHarness({
  config: baseConfig(args, { tokenBudget: { ...BUDGET, enforcement: 'warn' } }),
});
wireBudgetEvents(warnHarness, 'warn');

await runExample(warnHarness, async () => {
  // --- warn: emits events but completes. ---
  console.log('--- enforcement: warn ---');
  const { content, usage } = await warnHarness.chat(prompt);
  console.log(content);
  console.log(`[warn] completed despite over-budget: ${usage.totalTokens} tokens`);

  // --- block: throws before sending. ---
  console.log('\n--- enforcement: block ---');
  const blockHarness = await createHarness({
    config: baseConfig(args, { tokenBudget: { ...BUDGET, enforcement: 'block' } }),
  });
  wireBudgetEvents(blockHarness, 'block');
  try {
    await blockHarness.chat(prompt);
    console.error('[block] unexpectedly completed');
  } catch (err) {
    if (err instanceof TokenBudgetExceededError) {
      console.error(`[block] blocked pre-run as expected: ${err.message}`);
    } else {
      throw err;
    }
  } finally {
    await blockHarness.stop();
  }
});
