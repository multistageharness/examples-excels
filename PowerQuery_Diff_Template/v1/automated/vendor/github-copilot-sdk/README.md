# llm-sdk-github-copilot

A production harness around the **GitHub Copilot SDK** (`@github/copilot-sdk`):
chat, SSE streaming, structured I/O, tool calling, token budgets, session
persistence, SRE observability (OpenTelemetry), and a full event + hook
lifecycle — in dependency-light Node ESM (`.mjs`).

```js
import { createHarness } from 'llm-sdk-github-copilot';

const harness = await createHarness({
  config: {
    model: 'gpt-5-mini',
    reasoningEffort: 'low',
    tokenBudget: { maxTokens: 200_000 },
  },
});
try {
  const { content, usage } = await harness.chat('What is 2 + 2?');
  console.log(content, usage);
  console.log(harness.usageReport());
} finally {
  await harness.stop();
}
```

## How it fits together

```
┌─────────────────────────────────────────────────────────────┐
│ CopilotHarness (EventEmitter)                                │
│  chat() · stream() · structured() · registerTool() ·         │
│  preflight() · usageSummary() · continueFrom()                │
│                                                               │
│  config.mjs      defaults < file < env < overrides            │
│  cli-path.mjs    CLI_PATH resolution (explicit → env → walk)  │
│  tokens.mjs      estimates · TokenBudget · pre-run analysis   │
│  usage.mjs       tokens/tools/skills aggregation              │
│  hooks.mjs       awaitable interception points                │
│  store.mjs       request/response JSONL persistence           │
│  structured.mjs  JSON-Schema validate · extract · repair      │
│  observability.mjs  OTel golden signals (optional peer dep)   │
└──────────────┬───────────────────────────────────────────────┘
               │ @github/copilot-sdk (CopilotClient / sessions / events)
               ▼
        GitHub Copilot CLI runtime (spawned subprocess)
```

The harness consumes the SDK's typed session events (`assistant.usage`,
`tool.execution_*`, `skill.invoked`, `model.call_failure`,
`session.usage_info`, …) as its single source of truth for usage, budget
accounting, and golden-signal metrics.

## Install

```bash
npm install            # pulls @github/copilot-sdk (which bundles the CLI runtime)
npm test               # 81 unit tests, no network / no CLI spawn
```

Authentication follows the CLI: an existing `gh` login, or
`COPILOT_GITHUB_TOKEN` / `gitHubToken` config for headless use.

## Configuration

Precedence: **defaults < config file < environment < programmatic overrides**.
See [`harness.config.example.json`](harness.config.example.json) for every key.

| Key | Default | Purpose |
| --- | --- | --- |
| `cliPath` | auto | Explicit Copilot CLI entry (**CLI_PATH**). Fallback chain: `COPILOT_CLI_PATH` env → module resolution of `@github/copilot` → `node_modules` walk (vendored from [findCopilotNodeModuleDirectoryPath](https://github.com/carlosmarte/findCopilotNodeModuleDirectoryPath)) → SDK bundled runtime |
| `cliArgs` | `[]` | Extra runtime args (e.g. `--disable-builtin-mcps`) |
| `httpProxy` | env | **HTTP_PROXY (optional)** — applied to the spawned CLI's env only, never `process.env`; set `proxyFromEnv: false` to ignore ambient proxy vars |
| `model` | `gpt-5-mini` | Model id per session |
| `reasoningEffort` | `low` | `low` / `medium` / `high` / `xhigh` |
| `streaming` | `false` | Emit `assistant.message_delta` events |
| `systemPrompt` / `systemPromptFile` | — | Instruction document; `systemPromptMode: append\|replace` controls how it lands in the system message |
| `tokenBudget.maxTokens` | `null` | Hard ceiling on cumulative tokens; `enforcement: block` throws pre-run, `warn` proceeds + emits |
| `contextStore` | disabled | `{ enabled, directory }` — persist request/response context windows to the filesystem |
| `observability` | disabled | OTel wiring (below) |
| `structured.maxRepairAttempts` | `2` | Auto-repair rounds for structured output |
| `sessionDefaults` | `{}` | Escape hatch merged into every SDK `SessionConfig` |

Environment variables: `COPILOT_CLI_PATH`, `HTTP_PROXY`/`HTTPS_PROXY`,
`COPILOT_MODEL`, `COPILOT_REASONING_EFFORT`, `COPILOT_TOKEN_BUDGET`,
`COPILOT_HARNESS_STORE_DIR`, `COPILOT_SYSTEM_PROMPT_FILE`,
`OTEL_EXPORTER_OTLP_ENDPOINT`.

## Capabilities

### Chat & streaming

```js
const { content } = await harness.chat('prompt');           // buffered
for await (const item of harness.stream('prompt')) {        // streaming
  if (item.type === 'delta') process.stdout.write(item.content);
}
```

`formatSSE()` turns stream items into Server-Sent-Events frames — see
[`examples/03-sse-server.mjs`](examples/03-sse-server.mjs) for a complete
HTTP relay.

### Structured input/output

```js
const { value } = await harness.structured(
  'Analyze this code.',
  { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
  { input: { code: '…' } },                 // structured input, rendered as fenced JSON
);
```

JSON is extracted from fences/prose, validated against the schema
(dependency-free draft-07 subset), and invalid replies trigger a repair
round-trip carrying the validation errors.

### Tool calling

```js
harness.registerTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } },
  handler: async ({ city }) => `${city}: 21°C`,
});
```

Handlers are wrapped with `beforeToolCall` (can **deny**), `afterToolCall`,
`onToolFailure`, timing, and events. Failures return a structured
`resultType: 'failure'` to the model instead of crashing the run.

### Token budget & pre-run analysis

```js
const report = harness.preflight(prompt, { expectedOutputTokens: 200 });
// { breakdown, estimatedTotalTokens, budget, fitsWithinBudget, recommendation }
```

Every `chat()` runs this gate automatically; actual spend is reconciled from
`assistant.usage` events. `budget:warn` fires at `warnAtPercent`,
`budget:exceeded` + `TokenBudgetExceededError` at the ceiling.

### Usage summary

`harness.usageSummary()` → tokens (in/out/reasoning/cache), per-model and
per-tool stats (calls, success/failure, latency), skill invocations,
provider/rate-limit/session error counts, TTFT/duration percentiles, context
window utilization, budget snapshot. `harness.usageReport()` renders it for
humans.

### Sessions: attach, resume, persist

```js
harness.attachContext([{ role: 'user', content: '…' }]);   // splice prior turns
await harness.resumeSession(sessionId);                     // CLI-side resume
await harness.continueFrom(sessionId);                      // resume, else replay from store
```

With `contextStore.enabled`, every exchange is appended to
`<dir>/<sessionId>.jsonl` (+ `.meta.json`), so conversations survive process
restarts even when the CLI-side session is gone.

### SRE observability

CLI-side: `observability.{otlpEndpoint,filePath,exporterType,captureContent}`
map to the Copilot CLI's **native OTel exporter** (the SDK sets the env vars
on the spawned runtime), so CLI traces flow straight to Prometheus / Grafana /
Jaeger / Datadog / Dynatrace / New Relic via OTLP. `onGetTraceContext` is
wired automatically so harness spans and CLI spans share one distributed
trace.

Harness-side golden signals (via optional `@opentelemetry/api` peer dep —
no-ops when absent):

| Signal | Instrument |
| --- | --- |
| Latency | `copilot_harness.request.duration_ms`, `copilot_harness.request.ttft_ms` |
| Traffic | `copilot_harness.tokens` (direction attr), `copilot_harness.requests` |
| Errors | `copilot_harness.errors` (kind = `provider` / `rate_limit` / `session` / `harness`) |
| Saturation | `copilot_harness.budget.utilization`, `copilot_harness.context_window.utilization` |
| Tools/MCP | `copilot_harness.tool.calls` (outcome attr), `copilot_harness.tool.duration_ms` |

### Events & hooks

Events (fire-and-forget): `started`, `stopped`, `session:created`,
`session:resumed`, `session:replayed`, `run:start`, `run:end`, `delta`,
`message`, `idle`, `preflight`, `budget:warn`, `budget:exceeded`,
`tool:call`, `tool:result`, `tool:error`, `tool:denied`, `usage:*`,
`structured:ok`, `structured:invalid`, `error:run`, `event` (raw SDK events).

Hooks (awaited, can veto): `beforeRun`, `afterRun`, `beforeToolCall`
(return `{ deny, reason }`), `afterToolCall`, `onToolFailure`,
`onPromptSubmit`, `onSessionStart`, `onSessionEnd`, `onError`,
`onBudgetWarning`, `onBudgetExceeded`. SDK-side session hooks
(`onPreToolUse`, `onPostToolUse`, …) are bridged automatically so the same
handlers fire for built-in tools too.

## Examples

Twenty-four runnable examples under [`examples/`](examples/README.md) cover chat,
streaming, an SSE HTTP server, structured output, tool calling with policy
denial, token budgets, session persistence, observability, and the
hook/event lifecycle — plus system-prompt shaping, multi-turn context,
resume/replay, RAG grounding, LLM-as-judge, batch classification,
streaming-with-tools, human-in-the-loop approval, PII redaction,
retry/fallback resilience, cost reporting, built-in MCPs, an interactive REPL,
and an enterprise proxy/headless-auth setup. See the
[catalog](examples/README.md) for the full table (examples 13, 14, and 22 are
demo-grade — they require a live, authenticated Copilot CLI). All accept
`--cli-path` and `--proxy`.

## Testing

`npm test` — 81 tests (node:test) run against a mock SDK client
([`test/helpers/mock-sdk.mjs`](test/helpers/mock-sdk.mjs)); no network, no
CLI subprocess. Coverage spans config precedence, CLI path resolution,
budget math, usage aggregation, hooks, the context store, structured
validation/extraction/repair, OTel metric emission (fake API), and the full
harness behavior including streaming and resume-with-replay.

## References

- [GitHub Copilot SDK getting started](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started)
- [carlosmarte/examples-github-copilot-cli-sdk](https://github.com/carlosmarte/examples-github-copilot-cli-sdk) — integration patterns this harness builds on
- [carlosmarte/findCopilotNodeModuleDirectoryPath](https://github.com/carlosmarte/findCopilotNodeModuleDirectoryPath) — CLI path discovery (vendored in `src/cli-path.mjs`)
