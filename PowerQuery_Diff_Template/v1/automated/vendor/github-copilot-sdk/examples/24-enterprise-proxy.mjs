// 24 — Enterprise setup: HTTP(S) proxy + headless auth.
//
// Enterprise deployments run behind a proxy with headless (non-interactive)
// auth. This example documents the full setup:
//   - httpProxy is applied to the spawned CLI's env ONLY (never process.env),
//     sourced from --proxy (or COPILOT_CLI_PROXY / HTTP(S)_PROXY when
//     proxyFromEnv is left on).
//   - proxyFromEnv: false makes the harness IGNORE ambient HTTP(S)_PROXY vars so
//     only the explicit --proxy is used.
//   - Headless auth via COPILOT_GITHUB_TOKEN, read from the environment and never
//     hard-coded in source.
//
// Run:
//   COPILOT_GITHUB_TOKEN=*** node examples/24-enterprise-proxy.mjs --proxy http://proxy.corp:8080 "prompt"
//   node examples/24-enterprise-proxy.mjs --model gpt-5-mini --effort low "Ping: are you reachable through the proxy?"

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No prompt => print usage and exit before starting the runtime (0 tokens).
const prompt = requirePrompt(args, 'node examples/24-enterprise-proxy.mjs --proxy http://proxy.corp:8080 "Ping through the proxy?"');

// proxyFromEnv:false => ignore ambient HTTP(S)_PROXY; only --proxy is applied
// (scoped to the spawned CLI's env). baseConfig wires args.httpProxy from --proxy.
const harness = await createHarness({
  config: baseConfig(args, { proxyFromEnv: false }),
});

// Headless auth is provided by the environment, never embedded in code.
if (process.env.COPILOT_GITHUB_TOKEN) {
  console.error('[auth] using headless COPILOT_GITHUB_TOKEN from env (never hard-coded)');
} else {
  console.error('[auth] no COPILOT_GITHUB_TOKEN set — falling back to interactive gh auth');
}
console.error(`[proxy] httpProxy=${args.httpProxy ?? '(none)'} proxyFromEnv=false`);

await runExample(harness, async () => {
  const { content, usage } = await harness.chat(prompt);
  console.log(content);
  console.log(`\n[${usage.totalTokens} tokens via ${args.httpProxy ? 'proxy' : 'direct'} connection]`);
});
