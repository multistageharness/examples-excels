import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CopilotHarness,
  createHarness,
  formatSSE,
  renderContextPreamble,
  assertUserMessage,
  EmptyPromptError,
} from "../src/harness.mjs";
import { TokenBudgetExceededError } from "../src/tokens.mjs";
import { StructuredOutputError } from "../src/structured.mjs";
import { mockDeps } from "./helpers/mock-sdk.mjs";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("chat: returns content, tracks usage, fires run events", async () => {
  const { deps, ref } = mockDeps({
    script: [{ content: "four", inputTokens: 12, outputTokens: 3 }],
  });
  const harness = new CopilotHarness({}, deps);
  const events = [];
  harness.on("run:start", () => events.push("run:start"));
  harness.on("run:end", () => events.push("run:end"));
  harness.on("usage:tokens", (r) =>
    events.push(`tokens:${r.inputTokens}/${r.outputTokens}`),
  );

  const result = await harness.chat("What is 2+2?");
  assert.equal(result.content, "four");
  assert.equal(result.sessionId, "mock-session-1");
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 3);
  assert.ok(
    events.includes("run:start") &&
      events.includes("run:end") &&
      events.includes("tokens:12/3"),
  );

  const summary = harness.usageSummary();
  assert.equal(summary.tokens.total, 15);
  assert.equal(summary.apiCalls, 1);
  assert.equal(summary.budget.used, 15);

  await harness.stop();
  assert.equal(ref.client.stopped, true);
});

test("session config carries model, reasoningEffort, system prompt, defaults", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "ok" }] });
  const harness = new CopilotHarness(
    {
      config: {
        model: "gpt-5-mini",
        reasoningEffort: "low",
        systemPrompt: "BE TERSE",
        sessionDefaults: { clientName: "my-app" },
      },
    },
    deps,
  );
  await harness.chat("hi");

  const cfg = ref.client.lastSessionConfig;
  assert.equal(cfg.model, "gpt-5-mini");
  assert.equal(cfg.reasoningEffort, "low");
  assert.deepEqual(cfg.systemMessage, { mode: "append", content: "BE TERSE" });
  assert.equal(cfg.clientName, "my-app");
  await harness.stop();
});

test("systemPromptMode replace and per-call model override", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "ok" }] });
  const harness = new CopilotHarness(
    {
      config: { systemPrompt: "X", systemPromptMode: "replace" },
    },
    deps,
  );
  await harness.createSession({
    model: "claude-sonnet-4.6",
    reasoningEffort: "high",
  });
  const cfg = ref.client.lastSessionConfig;
  assert.deepEqual(cfg.systemMessage, { mode: "replace", content: "X" });
  assert.equal(cfg.model, "claude-sonnet-4.6");
  assert.equal(cfg.reasoningEffort, "high");
  await harness.stop();
});

test("instruction document file becomes the system prompt", async () => {
  const dir = tmpDir("harness-instr-");
  const file = path.join(dir, "instructions.md");
  fs.writeFileSync(file, "# Project rules\nAlways cite sources.\n");
  const { deps, ref } = mockDeps({ script: [{ content: "ok" }] });
  const harness = new CopilotHarness(
    { config: { systemPromptFile: file } },
    deps,
  );
  await harness.chat("hi");
  assert.match(
    ref.client.lastSessionConfig.systemMessage.content,
    /Always cite sources/,
  );
  await harness.stop();
});

test("HTTP proxy is scoped to the child env, not process.env", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "ok" }] });
  const harness = new CopilotHarness(
    {
      config: { httpProxy: "http://****:*****@proxy:8080" },
    },
    deps,
  );
  await harness.start();
  assert.equal(
    ref.client.options.env.HTTPS_PROXY,
    "http://****:*****@proxy:8080",
  );
  assert.equal(
    ref.client.options.env.HTTP_PROXY,
    "http://****:*****@proxy:8080",
  );
  assert.notEqual(process.env.HTTPS_PROXY, "http://****:*****@proxy:8080");
  await harness.stop();
});

test("cliPath and cliArgs are passed through to the client factory", async () => {
  const dir = tmpDir("harness-cli-");
  const fakeCli = path.join(dir, "cli.js");
  fs.writeFileSync(fakeCli, "// cli");
  const { deps, ref } = mockDeps({ script: [{ content: "ok" }] });
  const harness = new CopilotHarness(
    {
      config: { cliPath: fakeCli, cliArgs: ["--disable-builtin-mcps"] },
    },
    deps,
  );
  await harness.start();
  assert.equal(ref.client.options.cliPath, fakeCli);
  assert.deepEqual(ref.client.options.cliArgs, ["--disable-builtin-mcps"]);
  await harness.stop();
});

test("token budget blocks a run whose estimate exceeds the ceiling", async () => {
  const { deps } = mockDeps({ script: [{ content: "never" }] });
  const harness = new CopilotHarness(
    {
      config: { tokenBudget: { maxTokens: 5, enforcement: "block" } },
    },
    deps,
  );
  let exceededHook = null;
  harness.hooks.register("onBudgetExceeded", (p) => {
    exceededHook = p;
  });

  await assert.rejects(
    harness.chat(
      "this prompt is far too long for a five token budget, clearly",
    ),
    TokenBudgetExceededError,
  );
  assert.ok(exceededHook);
  assert.equal(exceededHook.budget.maxTokens, 5);
  assert.equal(harness.usageSummary().tokens.total, 0); // nothing was sent
  await harness.stop();
});

test("token budget accumulates across runs and then blocks", async () => {
  const { deps } = mockDeps({
    script: [
      { content: "one", inputTokens: 10, outputTokens: 5 },
      { content: "never" },
    ],
  });
  const harness = new CopilotHarness(
    {
      config: { tokenBudget: { maxTokens: 16, enforcement: "block" } },
    },
    deps,
  );

  const first = await harness.chat("hi");
  assert.equal(first.content, "one");
  assert.equal(harness.budget.used, 15);

  await assert.rejects(harness.chat("hi again"), TokenBudgetExceededError);
  await harness.stop();
});

test("enforcement=warn lets the run proceed and emits budget:warn", async () => {
  const { deps } = mockDeps({
    script: [{ content: "went through", inputTokens: 50, outputTokens: 10 }],
  });
  const harness = new CopilotHarness(
    {
      config: { tokenBudget: { maxTokens: 10, enforcement: "warn" } },
    },
    deps,
  );
  const emitted = [];
  harness.on("budget:warn", () => emitted.push("warn"));
  harness.on("budget:exceeded", () => emitted.push("exceeded"));

  const result = await harness.chat(
    "long prompt that will not fit in ten tokens at all",
  );
  assert.equal(result.content, "went through");
  assert.ok(emitted.includes("warn"));
  assert.ok(emitted.includes("exceeded")); // actual spend blew the ceiling
  await harness.stop();
});

test("preflight reports the breakdown without sending", async () => {
  const { deps, ref } = mockDeps({ script: [] });
  const harness = new CopilotHarness(
    {
      config: { systemPrompt: "sys", tokenBudget: { maxTokens: 1000 } },
    },
    deps,
  );
  const report = harness.preflight("a prompt", { expectedOutputTokens: 100 });
  assert.ok(report.estimatedInputTokens > 0);
  assert.equal(report.breakdown.expectedOutputTokens, 100);
  assert.equal(report.fitsWithinBudget, true);
  assert.equal(ref.client, null); // nothing started
});

test("beforeRun hook can abort the run", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "never" }] });
  const harness = new CopilotHarness({}, deps);
  harness.hooks.register("beforeRun", ({ prompt }) => {
    if (/forbidden/.test(prompt)) throw new Error("blocked by policy");
  });
  await assert.rejects(harness.chat("forbidden topic"), /blocked by policy/);
  assert.equal(ref.client.sessions[0].sent.length, 0);
  await harness.stop();
});

test("stream yields deltas then the final message", async () => {
  const { deps } = mockDeps({ script: [{ content: "streamed reply" }] });
  const harness = new CopilotHarness({ config: { streaming: true } }, deps);

  const chunks = [];
  for await (const item of harness.stream("go")) {
    chunks.push(item);
  }
  const deltas = chunks.filter((c) => c.type === "delta");
  const finals = chunks.filter((c) => c.type === "message");
  assert.ok(
    deltas.length >= 2,
    `expected multiple deltas, got ${deltas.length}`,
  );
  assert.equal(deltas.map((d) => d.content).join(""), "streamed reply");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].content, "streamed reply");
  assert.ok(finals[0].usage.totalTokens > 0);
  await harness.stop();
});

test("formatSSE produces valid SSE frames (incl. multiline data)", () => {
  assert.equal(
    formatSSE({ event: "delta", data: { content: "hi" } }),
    'event: delta\ndata: {"content":"hi"}\n\n',
  );
  assert.equal(
    formatSSE({ id: 3, data: "line1\nline2" }),
    "id: 3\ndata: line1\ndata: line2\n\n",
  );
});

test("structured output: parses on first try", async () => {
  const { deps } = mockDeps({
    script: [{ content: '{"name":"Ada","age":36}' }],
  });
  const harness = new CopilotHarness({}, deps);
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: { name: { type: "string" }, age: { type: "integer" } },
  };
  const { value, attempts } = await harness.structured(
    "Extract the person",
    schema,
    {
      input: { text: "Ada is 36" },
    },
  );
  assert.deepEqual(value, { name: "Ada", age: 36 });
  assert.equal(attempts, 1);
  await harness.stop();
});

test("structured output: repairs after an invalid reply", async () => {
  const { deps, ref } = mockDeps({
    script: [
      { content: "Sure! The person is Ada." }, // no JSON
      { content: '```json\n{"name":"Ada","age":36}\n```' },
    ],
  });
  const harness = new CopilotHarness({}, deps);
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: { name: { type: "string" }, age: { type: "integer" } },
  };
  const invalidEvents = [];
  harness.on("structured:invalid", (e) => invalidEvents.push(e));

  const { value, attempts, usage } = await harness.structured(
    "Extract",
    schema,
  );
  assert.deepEqual(value, { name: "Ada", age: 36 });
  assert.equal(attempts, 2);
  assert.equal(invalidEvents.length, 1);
  assert.equal(usage.totalTokens, 30); // two mock calls at 15 each
  assert.match(
    ref.client.sessions[0].sent[1].prompt,
    /not valid against the required JSON Schema/,
  );
  await harness.stop();
});

test("structured output: throws after exhausting repair attempts", async () => {
  const { deps } = mockDeps({
    script: [{ content: "nope" }, { content: "still nope" }],
  });
  const harness = new CopilotHarness(
    {
      config: { structured: { maxRepairAttempts: 1 } },
    },
    deps,
  );
  await assert.rejects(
    harness.structured("Extract", { type: "object" }),
    StructuredOutputError,
  );
  await harness.stop();
});

test("registered tools are wrapped: success, failure, and hook denial", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "ok" }] });
  const harness = new CopilotHarness({}, deps);
  harness.registerTool({
    name: "lookup",
    description: "Look something up",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    handler: async ({ q }) => {
      if (q === "explode") throw new Error("backend down");
      return `result for ${q}`;
    },
  });
  harness.hooks.register("beforeToolCall", ({ args }) =>
    args?.q === "secret"
      ? { deny: true, reason: "q is classified" }
      : undefined,
  );

  await harness.createSession();
  const wrapped = ref.client.lastSessionConfig.tools[0];
  assert.equal(wrapped.name, "lookup");

  const emitted = [];
  for (const evt of ["tool:call", "tool:result", "tool:error", "tool:denied"]) {
    harness.on(evt, (p) => emitted.push(evt));
  }
  const failures = [];
  harness.hooks.register("onToolFailure", (p) => failures.push(p));

  const ok = await wrapped.handler({ q: "cats" }, { sessionId: "s" });
  assert.equal(ok, "result for cats");

  const denied = await wrapped.handler({ q: "secret" }, { sessionId: "s" });
  assert.equal(denied.resultType, "denied");
  assert.match(denied.textResultForLlm, /classified/);

  const failed = await wrapped.handler({ q: "explode" }, { sessionId: "s" });
  assert.equal(failed.resultType, "failure");
  assert.match(failed.error, /backend down/);
  assert.equal(failures.length, 1);

  assert.deepEqual(emitted, [
    "tool:call",
    "tool:result",
    "tool:denied",
    "tool:call",
    "tool:error",
  ]);
  await harness.stop();
});

test("registerTool validates input", () => {
  const harness = new CopilotHarness({}, mockDeps().deps);
  assert.throws(() => harness.registerTool({ name: "x" }), TypeError);
  assert.throws(() => harness.registerTool({ handler: () => {} }), TypeError);
});

test("SDK hook bridge: onPreToolUse deny + lifecycle hooks fire", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "ok" }] });
  const harness = new CopilotHarness({}, deps);
  harness.hooks.register("beforeToolCall", ({ toolName }) =>
    toolName === "shell"
      ? { deny: true, reason: "no shell allowed" }
      : undefined,
  );
  const seen = [];
  harness.hooks.register("afterToolCall", (p) =>
    seen.push(["after", p.toolName]),
  );
  harness.hooks.register("onPromptSubmit", (p) =>
    seen.push(["prompt", p.prompt]),
  );
  harness.hooks.register("onSessionStart", () => seen.push(["start"]));
  harness.hooks.register("onError", (p) => seen.push(["error", p.phase]));

  await harness.createSession();
  const sdkHooks = ref.client.lastSessionConfig.hooks;

  const deny = await sdkHooks.onPreToolUse({
    toolName: "shell",
    toolArgs: {},
    sessionId: "s",
  });
  assert.equal(deny.permissionDecision, "deny");
  assert.match(deny.permissionDecisionReason, /no shell/);

  const allow = await sdkHooks.onPreToolUse({
    toolName: "web",
    toolArgs: {},
    sessionId: "s",
  });
  assert.equal(allow, undefined);

  await sdkHooks.onPostToolUse({
    toolName: "web",
    toolArgs: {},
    toolResult: {},
    sessionId: "s",
  });
  await sdkHooks.onUserPromptSubmitted({ prompt: "p", sessionId: "s" });
  await sdkHooks.onSessionStart({ sessionId: "s", source: "new" });
  await sdkHooks.onErrorOccurred({
    error: "x",
    errorContext: "model_call",
    sessionId: "s",
  });

  assert.deepEqual(seen, [
    ["after", "web"],
    ["prompt", "p"],
    ["start"],
    ["error", "model_call"],
  ]);
  await harness.stop();
});

test("context store persists request/response exchanges", async () => {
  const dir = tmpDir("harness-ctx-");
  const { deps } = mockDeps({ script: [{ content: "stored answer" }] });
  const harness = new CopilotHarness(
    {
      config: { contextStore: { enabled: true, directory: dir } },
    },
    deps,
  );

  await harness.chat("store me");
  const exchanges = harness.store.load("mock-session-1");
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].request.prompt, "store me");
  assert.equal(exchanges[0].response.content, "stored answer");
  assert.equal(exchanges[0].usage.totalTokens, 15);
  assert.equal(exchanges[0].meta.model, "gpt-5-mini");
  await harness.stop();
});

test("attachContext prepends prior conversation to the next prompt only", async () => {
  const { deps, ref } = mockDeps({
    script: [{ content: "a1" }, { content: "a2" }],
  });
  const harness = new CopilotHarness({}, deps);
  harness.attachContext([
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ]);
  await harness.chat("follow-up");
  await harness.chat("second call");

  const [first, second] = ref.client.sessions[0].sent;
  assert.match(first.prompt, /<conversation-context>/);
  assert.match(first.prompt, /earlier question/);
  assert.match(first.prompt, /follow-up$/);
  assert.ok(!second.prompt.includes("conversation-context"));
  await harness.stop();
});

test("resumeSession resumes by id; continueFrom falls back to stored replay", async () => {
  const dir = tmpDir("harness-resume-");

  // Phase 1: populate the store.
  {
    const { deps } = mockDeps({ script: [{ content: "original answer" }] });
    const h = new CopilotHarness(
      {
        config: { contextStore: { enabled: true, directory: dir } },
      },
      deps,
    );
    await h.chat("original question");
    await h.stop();
  }

  // Phase 2: CLI-side resume works.
  {
    const { deps, ref } = mockDeps({ script: [{ content: "resumed" }] });
    const h = new CopilotHarness({}, deps);
    await h.resumeSession("mock-session-1");
    assert.equal(h.sessionId, "mock-session-1");
    await h.stop();
  }

  // Phase 3: CLI-side resume fails → replay from store.
  {
    const { deps, ref } = mockDeps({
      script: [{ content: "continued" }],
      failResume: true,
    });
    const h = new CopilotHarness(
      {
        config: { contextStore: { enabled: true, directory: dir } },
      },
      deps,
    );
    const replayed = [];
    h.on("session:replayed", (p) => replayed.push(p));

    await h.continueFrom("mock-session-1");
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].from, "mock-session-1");
    assert.equal(replayed[0].messages, 2);

    const { content } = await h.chat("and now?");
    assert.equal(content, "continued");
    const sent = ref.client.sessions[0].sent[0].prompt;
    assert.match(sent, /original question/);
    assert.match(sent, /original answer/);
    await h.stop();
  }
});

test("continueFrom without store or stored data throws a helpful error", async () => {
  const { deps } = mockDeps({ script: [], failResume: true });
  const harness = new CopilotHarness({}, deps);
  await assert.rejects(harness.continueFrom("ghost"), /no context store/);
  await harness.stop();

  const dir = tmpDir("harness-empty-store-");
  const { deps: deps2 } = mockDeps({ script: [], failResume: true });
  const harness2 = new CopilotHarness(
    {
      config: { contextStore: { enabled: true, directory: dir } },
    },
    deps2,
  );
  await assert.rejects(harness2.continueFrom("ghost"), /no stored context/);
  await harness2.stop();
});

test("usageReport includes budget line when configured", async () => {
  const { deps } = mockDeps({
    script: [{ content: "ok", inputTokens: 30, outputTokens: 10 }],
  });
  const harness = new CopilotHarness(
    {
      config: { tokenBudget: { maxTokens: 100 } },
    },
    deps,
  );
  await harness.chat("hi");
  const report = harness.usageReport();
  assert.match(report, /tokens: 40 total/);
  assert.match(report, /budget: 40\/100 tokens \(40%, block\)/);
  await harness.stop();
});

test("createHarness convenience starts the harness", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "ok" }] });
  const harness = await createHarness({}, deps);
  assert.ok(ref.client);
  await harness.stop();
});

test("assertUserMessage rejects empty/missing messages, accepts real ones", () => {
  for (const bad of [undefined, null, "", "   ", "\n\t ", 42, {}]) {
    assert.throws(() => assertUserMessage(bad), EmptyPromptError);
  }
  assert.doesNotThrow(() => assertUserMessage("hi"));
  // Method name is threaded into the error for a clearer message.
  assert.throws(() => assertUserMessage("", "structured"), (err) => {
    assert.ok(err instanceof EmptyPromptError);
    assert.equal(err.method, "structured");
    return true;
  });
});

test("chat: empty message throws EmptyPromptError without contacting the model", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "should not be used" }] });
  const harness = new CopilotHarness({}, deps);

  for (const bad of [undefined, "", "   "]) {
    await assert.rejects(() => harness.chat(bad), EmptyPromptError);
  }
  // Guard fires before _ensureSession() — so the CLI runtime was never started
  // and no request was sent: zero tokens spent.
  assert.equal(ref.client, null);
  assert.equal(harness.usageSummary().tokens.total, 0);
});

test("stream: empty message throws EmptyPromptError without contacting the model", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "nope" }] });
  const harness = new CopilotHarness({}, deps);

  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of harness.stream("   ")) { /* drain */ }
  }, EmptyPromptError);
  assert.equal(ref.client, null);
});

test("structured: empty task throws EmptyPromptError without contacting the model", async () => {
  const { deps, ref } = mockDeps({ script: [{ content: "{}" }] });
  const harness = new CopilotHarness({}, deps);

  await assert.rejects(
    () => harness.structured("", { type: "object" }),
    EmptyPromptError,
  );
  assert.equal(ref.client, null);
});

test("renderContextPreamble formats roles and is empty for no messages", () => {
  assert.equal(renderContextPreamble([]), "");
  const text = renderContextPreamble([
    { role: "user", content: "q" },
    { content: "r" },
  ]);
  assert.match(text, /USER: q/);
  assert.match(text, /USER: r/); // role defaults to user
});
