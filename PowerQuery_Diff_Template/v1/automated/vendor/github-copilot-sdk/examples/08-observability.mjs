// 08 — SRE observability: OTel golden signals + CLI-side trace export.
//
// Two telemetry paths run at once:
//   1. CLI runtime traces — `observability.filePath` configures the Copilot
//      CLI's native OTel file exporter (JSONL spans you can ship anywhere);
//      point `otlpEndpoint` at an OTLP collector for APM backends instead.
//   2. Harness golden signals — when @opentelemetry/api (+ an SDK) is
//      installed, the harness records TTFT, latency, token counters, tool
//      outcomes, and error counts (rate-limit vs provider vs session).
//
// Without an OTel SDK installed this still runs: harness metrics no-op and
// the usage tracker provides the same numbers in-process.
//
// Run:
//   node examples/08-observability.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/08-observability.mjs --model gpt-5-mini --effort low "Why do SREs track time-to-first-token for LLM services?"

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No message => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/08-observability.mjs "Why do SREs track time-to-first-token?"');
const harness = await createHarness({
  config: baseConfig(args, {
    observability: {
      enabled: true,
      serviceName: 'copilot-harness-example',
      filePath: '.copilot-harness/traces.jsonl', // CLI-side OTel file exporter
      captureContent: false,                      // never ship prompts to telemetry
    },
  }),
});

// Golden signals are also observable in-process via events:
harness.on('usage:tokens', (r) => console.error(`[signal] tokens in=${r.inputTokens} out=${r.outputTokens}`));
harness.on('usage:tool:end', (r) => console.error(`[signal] tool=${r.tool} ok=${r.success} ${r.durationMs}ms`));
harness.on('usage:provider:error', (r) => console.error(`[signal] provider error status=${r.status}`));
harness.on('usage:context', (r) => console.error(`[signal] context ${r.currentTokens}/${r.tokenLimit}`));

await runExample(harness, async () => {
  const { content, usage } = await harness.chat(prompt);
  console.log(content);

  const s = harness.usageSummary();
  console.log('\nGolden signals snapshot:');
  console.log(`  latency  : TTFT ${JSON.stringify(s.latency.ttftMs)} / total ${usage.durationMs}ms`);
  console.log(`  traffic  : ${s.tokens.total} tokens across ${s.apiCalls} call(s)`);
  console.log(`  errors   : ${JSON.stringify(s.errors)}`);
  console.log(`  saturation: budget ${JSON.stringify(s.budget)}`);
  console.log('\nCLI traces (if any) at .copilot-harness/traces.jsonl');
});
