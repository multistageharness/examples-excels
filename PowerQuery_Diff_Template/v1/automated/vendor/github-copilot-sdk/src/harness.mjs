/**
 * CopilotHarness — the orchestration layer around @github/copilot-sdk.
 *
 * Wraps a CopilotClient with:
 *   - config-driven model / reasoning-effort / streaming selection
 *   - CLI_PATH resolution and HTTP_PROXY scoping (child env only)
 *   - chat + SSE-style streaming (async iterator over deltas)
 *   - structured input/output against JSON Schemas with auto-repair
 *   - tool registration with hook interception (deny/observe)
 *   - token budget enforcement with pre-run usage analysis
 *   - usage aggregation (tokens, tools, skills) and summaries
 *   - context-window persistence + conversation attach/resume
 *   - OpenTelemetry golden signals and distributed trace propagation
 *   - an EventEmitter surface plus awaitable lifecycle hooks
 *
 * The SDK module is injected lazily (or via deps for tests), so unit tests
 * run without spawning the Copilot CLI.
 */

import { EventEmitter } from 'node:events';

import { loadConfig, resolveSystemPrompt } from './config.mjs';
import { resolveCliPath } from './cli-path.mjs';
import {
  TokenBudget,
  analyzeRun,
  estimateTokens,
} from './tokens.mjs';
import { UsageTracker } from './usage.mjs';
import { HookManager } from './hooks.mjs';
import { ContextStore } from './store.mjs';
import { Observability, telemetryConfigFor } from './observability.mjs';
import {
  StructuredOutputError,
  buildStructuredPrompt,
  buildRepairPrompt,
  parseStructuredResponse,
} from './structured.mjs';

/** Format one Server-Sent-Events frame. */
export function formatSSE({ event, data, id } = {}) {
  const lines = [];
  if (id != null) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  const payload = typeof data === 'string' ? data : JSON.stringify(data ?? null);
  for (const line of payload.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * Thrown when chat/stream/structured is called without an actual user message.
 * Guards against spending tokens on a request whose only content is built-in
 * scaffolding (context preamble, system prompt, structured-schema wrapper).
 */
export class EmptyPromptError extends Error {
  constructor(method = 'chat') {
    super(
      `${method}() requires a non-empty user message; ` +
        'built-in scaffolding alone will not be sent to the model.',
    );
    this.name = 'EmptyPromptError';
    this.method = method;
  }
}

/**
 * Reject a missing/empty/whitespace-only user message before any LLM round-trip.
 * Validates the user-provided message only — scaffolding is added afterwards.
 * @param {unknown} message the raw user message
 * @param {string} method the calling method, for the error text
 */
export function assertUserMessage(message, method = 'chat') {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new EmptyPromptError(method);
  }
}

/** Render attached conversation history into a prompt preamble. */
export function renderContextPreamble(messages = []) {
  if (!messages.length) return '';
  const body = messages
    .map((m) => `${(m.role ?? 'user').toUpperCase()}: ${m.content}`)
    .join('\n');
  return [
    '<conversation-context>',
    'Prior conversation to continue from:',
    body,
    '</conversation-context>',
    '',
  ].join('\n');
}

/**
 * Resolve the user-facing answer from the assistant messages observed during a
 * run. Thinking ("phased-output") models emit `phase: "thinking"` messages
 * alongside the real `phase: "response"` one, and reasoning can trail the
 * answer in the event stream — so the last assistant.message is not reliably
 * the answer. Prefer the last non-thinking message that has content; fall back
 * to the last message, then to the raw SDK response.
 *
 * @param {Array<{content: string, phase?: string}>} messages collected messages
 * @param {object} [fallback] the raw response.data from sendAndWait
 * @returns {string} the answer content
 */
export function resolveAnswerContent(messages = [], fallback = undefined) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.phase !== 'thinking' && m.content) return m.content;
  }
  const last = messages[messages.length - 1];
  if (last) return last.content ?? '';
  return fallback?.content ?? '';
}

export class CopilotHarness extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.configFile] JSON config file
   * @param {object} [options.config]     programmatic config overrides
   * @param {object} [options.hooks]      initial hook handlers {name: fn|fn[]}
   * @param {object} [deps] test seams: { sdk, clientFactory, env }
   */
  constructor(options = {}, deps = {}) {
    super();
    this.config = loadConfig({
      configFile: options.configFile,
      overrides: options.config,
      env: deps.env ?? process.env,
    });
    this.hooks = new HookManager(options.hooks);
    this.budget = new TokenBudget(this.config.tokenBudget);
    this.usage = new UsageTracker();
    this.store = this.config.contextStore?.enabled
      ? new ContextStore({ directory: this.config.contextStore.directory })
      : null;
    this.obs = new Observability(this.config.observability);

    this._deps = deps;
    this._sdk = deps.sdk ?? null;
    this._client = null;
    this._session = null;
    this._tools = [];
    this._pendingContext = [];
    this._started = false;
    // Per-run collector for assistant messages + reasoning. Thinking models
    // emit phased messages (phase: "thinking" vs "response") and a separate
    // reasoning channel; we capture them here so chat() can resolve the answer
    // rather than trusting whichever assistant.message happened to arrive last.
    this._run = null;
  }

  /* ------------------------------------------------------------ *
   * lifecycle
   * ------------------------------------------------------------ */

  async _loadSdk() {
    if (!this._sdk) this._sdk = await import('@github/copilot-sdk');
    return this._sdk;
  }

  /** Resolve CLI path + env and construct the CopilotClient. Idempotent. */
  async start() {
    if (this._started) return this;
    await this.obs.init();

    const cliPath = resolveCliPath({
      cliPath: this.config.cliPath,
      env: this._deps.env ?? process.env,
      required: false, // SDK falls back to its bundled runtime
    });

    const env = { ...process.env, ...this.config.env };
    if (this.config.httpProxy) {
      // Scope the proxy to the spawned runtime only — never mutate process.env.
      env.HTTPS_PROXY = this.config.httpProxy;
      env.HTTP_PROXY = this.config.httpProxy;
    }

    const clientOptions = {
      env,
      ...(this.config.workingDirectory && { workingDirectory: this.config.workingDirectory }),
      ...(this.config.baseDirectory && { baseDirectory: this.config.baseDirectory }),
      ...(this.config.logLevel && { logLevel: this.config.logLevel }),
      ...(this.config.githubToken && { gitHubToken: this.config.githubToken }),
    };

    const telemetry = telemetryConfigFor(this.config.observability);
    if (telemetry) clientOptions.telemetry = telemetry;
    const traceProvider = this.obs.traceContextProvider();
    if (traceProvider) clientOptions.onGetTraceContext = traceProvider;

    if (this._deps.clientFactory) {
      this._client = await this._deps.clientFactory({ ...clientOptions, cliPath, cliArgs: this.config.cliArgs });
    } else {
      const sdk = await this._loadSdk();
      if (cliPath || this.config.cliArgs?.length) {
        clientOptions.connection = sdk.RuntimeConnection.forStdio({
          ...(cliPath && { path: cliPath }),
          ...(this.config.cliArgs?.length && { args: this.config.cliArgs }),
        });
      }
      this._client = new sdk.CopilotClient(clientOptions);
    }

    this._started = true;
    this.emit('started', { cliPath });
    return this;
  }

  get client() {
    return this._client;
  }

  get sessionId() {
    return this._session?.sessionId ?? null;
  }

  /** Stop the underlying client (always call — try/finally). */
  async stop() {
    const errors = [];
    if (this._session?.disconnect) {
      try {
        await this._session.disconnect();
      } catch (err) {
        errors.push(err);
      }
    }
    this._session = null;
    if (this._client) {
      try {
        const stopErrors = await this._client.stop();
        if (Array.isArray(stopErrors)) errors.push(...stopErrors);
      } catch (err) {
        errors.push(err);
      }
    }
    this._client = null;
    this._started = false;
    this.emit('stopped', { errors });
    return errors;
  }

  /* ------------------------------------------------------------ *
   * sessions
   * ------------------------------------------------------------ */

  _sdkHooksBridge() {
    const harness = this;
    return {
      async onPreToolUse(input) {
        const verdict = await harness.hooks.toolCallVerdict({
          toolName: input.toolName,
          args: input.toolArgs,
          sessionId: input.sessionId,
        });
        harness.emit('tool:start', { tool: input.toolName, args: input.toolArgs });
        if (verdict.deny) {
          harness.emit('tool:denied', { tool: input.toolName, reason: verdict.reason });
          return { permissionDecision: 'deny', permissionDecisionReason: verdict.reason };
        }
        return undefined;
      },
      async onPostToolUse(input) {
        await harness.hooks.run('afterToolCall', {
          toolName: input.toolName,
          args: input.toolArgs,
          result: input.toolResult,
          sessionId: input.sessionId,
        });
        return undefined;
      },
      async onPostToolUseFailure(input) {
        await harness.hooks.run('onToolFailure', {
          toolName: input.toolName,
          args: input.toolArgs,
          error: input.error,
          sessionId: input.sessionId,
        });
        return undefined;
      },
      async onUserPromptSubmitted(input) {
        await harness.hooks.run('onPromptSubmit', {
          prompt: input.prompt,
          sessionId: input.sessionId,
        });
        return undefined;
      },
      async onSessionStart(input) {
        await harness.hooks.run('onSessionStart', { sessionId: input.sessionId });
        return undefined;
      },
      async onSessionEnd(input) {
        await harness.hooks.run('onSessionEnd', {
          sessionId: input.sessionId,
          reason: input.reason,
        });
        return undefined;
      },
      async onErrorOccurred(input) {
        await harness.hooks.run('onError', {
          error: input.error,
          phase: input.errorContext,
          sessionId: input.sessionId,
        });
        return undefined;
      },
    };
  }

  /** Session event dispatcher: usage, observability, budget, re-emit. */
  _onSessionEvent(event) {
    this.emit('event', event);

    if (event.type === 'assistant.message_delta') {
      this.emit('delta', {
        content: event.data?.deltaContent ?? event.data?.content ?? '',
        event,
      });
    } else if (event.type === 'assistant.message') {
      const data = event.data ?? {};
      this._run?.messages.push({
        content: data.content ?? '',
        phase: data.phase,
        reasoningText: data.reasoningText,
      });
      if (data.reasoningText) this._run?.reasoning.push(data.reasoningText);
      this.emit('message', { content: data.content ?? '', event });
    } else if (event.type === 'assistant.reasoning') {
      // Extended thinking: capture for the result, never as answer content.
      // The live Copilot SDK carries the thinking text on `data.content`
      // (AssistantReasoningData.content). Fall back to `data.text` for any
      // older/alternate shape so we never silently drop the reasoning channel.
      const text = event.data?.content ?? event.data?.text;
      if (text) this._run?.reasoning.push(text);
    } else if (event.type === 'session.idle') {
      this.emit('idle', { event });
    }

    const record = this.usage.ingestEvent(event);
    if (!record) return;
    this.obs.ingest(record, event);
    this.emit(`usage:${record.kind}`, record);

    if (record.kind === 'tokens') {
      const spent = (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
      const state = this.budget.record(spent);
      this.obs.observeBudget(this.budget.snapshot());
      if (state === 'warn') {
        this.emit('budget:warn', this.budget.snapshot());
        this.hooks.run('onBudgetWarning', { budget: this.budget.snapshot() })
          .catch(() => {});
      } else if (state === 'exceeded') {
        this.emit('budget:exceeded', this.budget.snapshot());
        this.hooks.run('onBudgetExceeded', { budget: this.budget.snapshot() })
          .catch(() => {});
      }
    }
  }

  _buildSessionConfig(opts = {}) {
    const cfg = this.config;
    const systemPrompt = opts.systemPrompt ?? resolveSystemPrompt(cfg);
    const sessionConfig = {
      ...cfg.sessionDefaults,
      model: opts.model ?? cfg.model,
      reasoningEffort: opts.reasoningEffort ?? cfg.reasoningEffort,
      streaming: opts.streaming ?? cfg.streaming,
      ...(opts.workingDirectory ?? cfg.workingDirectory
        ? { workingDirectory: opts.workingDirectory ?? cfg.workingDirectory }
        : {}),
      hooks: this._sdkHooksBridge(),
      onEvent: (event) => this._onSessionEvent(event),
      ...opts.sessionConfig,
    };
    if (systemPrompt) {
      sessionConfig.systemMessage = cfg.systemPromptMode === 'replace'
        ? { mode: 'replace', content: systemPrompt }
        : { mode: 'append', content: systemPrompt };
    }
    if (this._tools.length) {
      sessionConfig.tools = this._tools.map((t) => this._wrapTool(t));
    }
    return sessionConfig;
  }

  /** Create a fresh session (disconnecting any current one). */
  async createSession(opts = {}) {
    await this.start();
    if (this._session?.disconnect) {
      await this._session.disconnect().catch(() => {});
    }
    this._session = await this._client.createSession(this._buildSessionConfig(opts));
    this.emit('session:created', { sessionId: this.sessionId });
    return this._session;
  }

  /** Resume a CLI-side session by id, preserving its history. */
  async resumeSession(sessionId, opts = {}) {
    await this.start();
    if (this._session?.disconnect) {
      await this._session.disconnect().catch(() => {});
    }
    this._session = await this._client.resumeSession(sessionId, this._buildSessionConfig(opts));
    this.emit('session:resumed', { sessionId: this.sessionId });
    return this._session;
  }

  /**
   * Continue a conversation. Tries a CLI-side resume first; when the session
   * no longer exists, falls back to replaying the stored context window from
   * the ContextStore into a new session.
   */
  async continueFrom(sessionId, opts = {}) {
    try {
      return await this.resumeSession(sessionId, opts);
    } catch (err) {
      if (!this.store) {
        throw new Error(
          `Cannot resume session ${sessionId} (${err.message}) and no context store is configured for replay`,
        );
      }
      const messages = this.store.asContextMessages(sessionId);
      if (!messages.length) {
        throw new Error(
          `Cannot resume session ${sessionId} (${err.message}) and no stored context found`,
        );
      }
      this.attachContext(messages);
      const session = await this.createSession(opts);
      this.emit('session:replayed', { from: sessionId, sessionId: this.sessionId, messages: messages.length });
      return session;
    }
  }

  /** Attach prior {role, content} messages; consumed by the next chat call. */
  attachContext(messages = []) {
    this._pendingContext.push(...messages);
    return this;
  }

  async _ensureSession(opts = {}) {
    if (!this._session) await this.createSession(opts);
    return this._session;
  }

  /* ------------------------------------------------------------ *
   * tools
   * ------------------------------------------------------------ */

  /**
   * Register a custom tool exposed to the model.
   * @param {{ name: string, description?: string, parameters?: object,
   *           handler: Function, skipPermission?: boolean }} tool
   */
  registerTool(tool) {
    if (!tool?.name || typeof tool.handler !== 'function') {
      throw new TypeError('registerTool requires { name, handler }');
    }
    this._tools.push(tool);
    return this;
  }

  /** Wrap a tool handler with hooks, events, and error capture. */
  _wrapTool(tool) {
    const harness = this;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      skipPermission: tool.skipPermission ?? true,
      async handler(args, invocation) {
        const startedAt = Date.now();
        const base = { toolName: tool.name, args, sessionId: invocation?.sessionId };
        const verdict = await harness.hooks.toolCallVerdict(base);
        if (verdict.deny) {
          harness.emit('tool:denied', { tool: tool.name, reason: verdict.reason });
          return {
            textResultForLlm: `Tool call denied: ${verdict.reason}`,
            resultType: 'denied',
          };
        }
        harness.emit('tool:call', { tool: tool.name, args });
        try {
          const result = await tool.handler(args, invocation);
          const durationMs = Date.now() - startedAt;
          harness.emit('tool:result', { tool: tool.name, result, durationMs });
          await harness.hooks.run('afterToolCall', { ...base, result, durationMs });
          return result;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          harness.emit('tool:error', { tool: tool.name, error, durationMs });
          await harness.hooks.run('onToolFailure', { ...base, error });
          return {
            textResultForLlm: `Tool "${tool.name}" failed: ${error?.message ?? error}`,
            resultType: 'failure',
            error: String(error?.message ?? error),
          };
        }
      },
    };
  }

  /* ------------------------------------------------------------ *
   * preflight / budget
   * ------------------------------------------------------------ */

  /** Pre-run token usage analysis without sending anything. */
  preflight(prompt, opts = {}) {
    return analyzeRun({
      prompt,
      systemPrompt: opts.systemPrompt ?? resolveSystemPrompt(this.config),
      context: [...this._pendingContext, ...(opts.context ?? [])],
      attachments: opts.attachments,
      expectedOutputTokens: opts.expectedOutputTokens,
    }, this.budget);
  }

  async _gateOnBudget(analysis) {
    this.emit('preflight', analysis);
    if (!analysis.fitsWithinBudget) {
      if (this.budget.enforcement === 'block') {
        await this.hooks.run('onBudgetExceeded', {
          budget: this.budget.snapshot(),
          estimate: analysis.estimatedTotalTokens,
        });
        this.obs.recordError('harness', { reason: 'budget_blocked' });
        this.emit('budget:exceeded', this.budget.snapshot());
      } else {
        this.emit('budget:warn', this.budget.snapshot());
      }
    }
    // Throws in 'block' mode:
    this.budget.checkOrThrow(analysis.estimatedTotalTokens);
  }

  /* ------------------------------------------------------------ *
   * chat / streaming / structured
   * ------------------------------------------------------------ */

  _composePrompt(prompt, opts = {}) {
    const context = [...this._pendingContext, ...(opts.context ?? [])];
    this._pendingContext = [];
    return context.length ? renderContextPreamble(context) + prompt : prompt;
  }

  /**
   * Send a prompt and await the complete response.
   *
   * @returns {{
   *   content: string,                         user-facing answer (never the chain-of-thought)
   *   reasoning: string|null,                  joined extended-thinking text, or null
   *   thinking: {text: string, steps: string[]}|null,  structured thinking: joined text + ordered blocks
   *   sessionId: string,
   *   usage: object,
   *   response: object                         raw Copilot SDK sendAndWait result (the live `$response`)
   * }}
   */
  async chat(prompt, opts = {}) {
    assertUserMessage(prompt, 'chat');
    await this._ensureSession(opts);
    const finalPrompt = this._composePrompt(prompt, opts);
    const analysis = this.preflight(finalPrompt, { ...opts, context: [] });
    await this.hooks.run('beforeRun', { prompt: finalPrompt, sessionId: this.sessionId, analysis });
    await this._gateOnBudget(analysis);

    const before = this.usage.summary().tokens;
    this.obs.recordRequestStart({ model: this.config.model });
    this.emit('run:start', { prompt: finalPrompt, sessionId: this.sessionId });
    const startedAt = Date.now();
    // Collect assistant messages + reasoning emitted during this run so the
    // answer is resolved phase-aware (see resolveAnswerContent), not by
    // trusting whichever assistant.message sendAndWait returned last.
    this._run = { messages: [], reasoning: [] };

    try {
      const response = await this.obs.withSpan(
        'copilot_harness.chat',
        { 'gen_ai.request.model': this.config.model, 'session.id': this.sessionId ?? '' },
        () => this._session.sendAndWait(
          {
            prompt: finalPrompt,
            ...(opts.attachmentRefs?.length && { attachments: opts.attachmentRefs }),
          },
          opts.timeout ?? this.config.requestTimeoutMs,
        ),
      );
      const content = resolveAnswerContent(this._run.messages, response?.data);
      const reasoningSteps = [...this._run.reasoning];
      const reasoning = reasoningSteps.length ? reasoningSteps.join('\n\n') : null;
      // Structured view of the model's extended thinking: the joined `text`
      // plus the ordered reasoning blocks (`steps`). null when the turn emitted
      // no reasoning (non-thinking model, or reasoning effort produced none).
      const thinking = reasoningSteps.length
        ? { text: reasoning, steps: reasoningSteps }
        : null;
      const after = this.usage.summary().tokens;
      const runUsage = {
        inputTokens: after.input - before.input,
        outputTokens: after.output - before.output,
        totalTokens: after.total - before.total,
        durationMs: Date.now() - startedAt,
      };

      this.store?.saveExchange(this.sessionId, {
        request: { prompt: finalPrompt },
        response: { content },
        usage: runUsage,
        meta: { model: this.config.model },
      });

      const result = { content, reasoning, thinking, sessionId: this.sessionId, usage: runUsage, response };
      await this.hooks.run('afterRun', {
        prompt: finalPrompt,
        response: content,
        usage: runUsage,
        sessionId: this.sessionId,
      });
      this.emit('run:end', result);
      return result;
    } catch (error) {
      this.obs.recordError('harness', { reason: 'chat_failed' });
      await this.hooks.run('onError', { error, phase: 'chat', sessionId: this.sessionId });
      this.emit('error:run', { error, prompt: finalPrompt });
      throw error;
    } finally {
      this._run = null;
    }
  }

  /**
   * Streaming chat: async generator yielding
   *   { type: 'delta', content }   for each streamed chunk
   *   { type: 'message', content, usage, sessionId } once, at the end
   *
   * Pipe to an HTTP response with formatSSE() for SSE delivery.
   */
  async *stream(prompt, opts = {}) {
    assertUserMessage(prompt, 'stream');
    await this._ensureSession({ ...opts, streaming: true });

    const queue = [];
    let notify = null;
    let done = false;
    const push = (item) => {
      queue.push(item);
      notify?.();
    };
    const offDelta = this._session.on('assistant.message_delta', (event) => {
      const content = event?.data?.deltaContent ?? event?.data?.content ?? '';
      if (content) push({ type: 'delta', content });
    });

    const chatPromise = this.chat(prompt, opts)
      .then((result) => {
        push({ type: 'message', content: result.content, usage: result.usage, sessionId: result.sessionId });
      })
      .catch((error) => {
        push({ type: 'error', error });
      })
      .finally(() => {
        done = true;
        notify?.();
      });

    try {
      while (true) {
        while (queue.length) {
          const item = queue.shift();
          if (item.type === 'error') throw item.error;
          yield item;
          if (item.type === 'message') return;
        }
        if (done && !queue.length) return;
        await new Promise((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    } finally {
      offDelta?.();
      await chatPromise.catch(() => {});
    }
  }

  /**
   * Structured output: ask for JSON conforming to `schema`, validate, and
   * auto-repair up to config.structured.maxRepairAttempts times.
   *
   * @param {string} task natural-language task description
   * @param {object} schema JSON Schema the response must satisfy
   * @param {object} [opts] { input, inputLabel, ...chat opts }
   * @returns {{ value: any, content: string, attempts: number, usage: object }}
   */
  async structured(task, schema, opts = {}) {
    assertUserMessage(task, 'structured');
    const maxAttempts = 1 + (this.config.structured?.maxRepairAttempts ?? 2);
    let prompt = buildStructuredPrompt({
      task,
      input: opts.input,
      label: opts.inputLabel,
      schema,
    });
    let lastErrors = [];
    let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const { content, usage } = await this.chat(prompt, opts);
      totalUsage = {
        inputTokens: totalUsage.inputTokens + usage.inputTokens,
        outputTokens: totalUsage.outputTokens + usage.outputTokens,
        totalTokens: totalUsage.totalTokens + usage.totalTokens,
      };
      const parsed = parseStructuredResponse(content, schema);
      if (parsed.ok) {
        this.emit('structured:ok', { attempts: attempt });
        return { value: parsed.value, content, attempts: attempt, usage: totalUsage };
      }
      lastErrors = parsed.errors;
      this.emit('structured:invalid', { attempt, errors: lastErrors });
      prompt = buildRepairPrompt({ errors: lastErrors, schema });
    }

    throw new StructuredOutputError(
      `Structured output failed after ${maxAttempts} attempt(s): ${lastErrors.join('; ')}`,
      { errors: lastErrors, attempts: maxAttempts },
    );
  }

  /* ------------------------------------------------------------ *
   * usage summaries
   * ------------------------------------------------------------ */

  /** Usage summary object: tokens, tools, skills, models, errors, latency. */
  usageSummary() {
    return {
      ...this.usage.summary(),
      budget: this.budget.snapshot(),
    };
  }

  /** Human-readable usage report. */
  usageReport() {
    const lines = [this.usage.report()];
    const b = this.budget.snapshot();
    if (b.maxTokens != null) {
      lines.push(`budget: ${b.used}/${b.maxTokens} tokens (${b.utilizationPercent}%, ${b.enforcement})`);
    }
    return lines.join('\n');
  }
}

/** Convenience: construct + start in one call. */
export async function createHarness(options = {}, deps = {}) {
  const harness = new CopilotHarness(options, deps);
  await harness.start();
  return harness;
}
