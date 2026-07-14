/**
 * Usage aggregation: tokens, tools, skills, models, errors, context window.
 *
 * The tracker consumes raw Copilot SDK session events (`ingestEvent`) and
 * keeps running aggregates that `summary()` renders into a single report —
 * the "ability to summarize usage (tokens, tools, skills)" surface, and the
 * data source for the SRE golden signals (TTFT, latency, token consumption,
 * tool success/failure, provider errors).
 */

export class UsageTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.tokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    };
    this.apiCalls = 0;
    this.cost = 0;
    /** per-model: tokens + call counts + latency stats */
    this.models = new Map();
    /** per-tool: calls, success, failure, durations */
    this.tools = new Map();
    /** skill name -> invocation count */
    this.skills = new Map();
    this.errors = { providerFailures: 0, rateLimited: 0, sessionErrors: 0 };
    this.latency = { ttftMs: [], callDurationMs: [] };
    this.contextWindow = null; // latest session.usage_info data
    /** in-flight tool executions: toolCallId -> { name, startedAt } */
    this._openToolCalls = new Map();
  }

  _model(name) {
    if (!this.models.has(name)) {
      this.models.set(name, { calls: 0, inputTokens: 0, outputTokens: 0, totalDurationMs: 0 });
    }
    return this.models.get(name);
  }

  _tool(name) {
    if (!this.tools.has(name)) {
      this.tools.set(name, { calls: 0, succeeded: 0, failed: 0, totalDurationMs: 0 });
    }
    return this.tools.get(name);
  }

  /**
   * Feed a Copilot SDK session event. Returns a normalized record when the
   * event affected usage (useful for re-emitting), else null.
   */
  ingestEvent(event) {
    if (!event || typeof event !== 'object') return null;
    switch (event.type) {
      case 'assistant.usage': {
        const d = event.data ?? {};
        const input = d.inputTokens ?? 0;
        const output = d.outputTokens ?? 0;
        this.tokens.input += input;
        this.tokens.output += output;
        this.tokens.reasoning += d.reasoningTokens ?? 0;
        this.tokens.cacheRead += d.cacheReadTokens ?? 0;
        this.tokens.cacheWrite += d.cacheWriteTokens ?? 0;
        this.tokens.total = this.tokens.input + this.tokens.output;
        this.apiCalls += 1;
        if (typeof d.cost === 'number') this.cost += d.cost;
        if (typeof d.timeToFirstTokenMs === 'number') this.latency.ttftMs.push(d.timeToFirstTokenMs);
        if (typeof d.duration === 'number') this.latency.callDurationMs.push(d.duration);
        const m = this._model(d.model ?? 'unknown');
        m.calls += 1;
        m.inputTokens += input;
        m.outputTokens += output;
        m.totalDurationMs += d.duration ?? 0;
        return { kind: 'tokens', inputTokens: input, outputTokens: output, model: d.model };
      }
      case 'session.usage_info': {
        this.contextWindow = { ...event.data };
        return { kind: 'context', ...event.data };
      }
      case 'tool.execution_start': {
        const d = event.data ?? {};
        const name = d.toolName ?? d.tool?.name ?? 'unknown';
        this._openToolCalls.set(d.toolCallId ?? event.id, {
          name,
          startedAt: Date.parse(event.timestamp) || Date.now(),
        });
        const t = this._tool(name);
        t.calls += 1;
        return { kind: 'tool:start', tool: name, toolCallId: d.toolCallId };
      }
      case 'tool.execution_complete': {
        const d = event.data ?? {};
        const open = this._openToolCalls.get(d.toolCallId);
        this._openToolCalls.delete(d.toolCallId);
        const name = open?.name
          ?? d.toolDescription?.name
          ?? 'unknown';
        const t = this._tool(name);
        // The start event was missed (e.g. tracker attached mid-run) — count
        // the call here so totals stay consistent.
        if (!open) t.calls += 1;
        const endedAt = Date.parse(event.timestamp) || Date.now();
        const durationMs = open ? Math.max(0, endedAt - open.startedAt) : 0;
        t.totalDurationMs += durationMs;
        if (d.success) t.succeeded += 1;
        else t.failed += 1;
        return {
          kind: 'tool:end',
          tool: name,
          toolCallId: d.toolCallId,
          success: !!d.success,
          durationMs,
          error: d.error ?? null,
        };
      }
      case 'skill.invoked': {
        const name = event.data?.name ?? event.data?.skillName ?? 'unknown';
        this.skills.set(name, (this.skills.get(name) ?? 0) + 1);
        return { kind: 'skill', skill: name };
      }
      case 'model.call_failure': {
        this.errors.providerFailures += 1;
        const d = event.data ?? {};
        const status = d.statusCode ?? d.status ?? null;
        const msg = String(d.message ?? d.error ?? '');
        if (status === 429 || /rate.?limit/i.test(msg)) this.errors.rateLimited += 1;
        return { kind: 'provider:error', status, message: msg };
      }
      case 'session.error': {
        this.errors.sessionErrors += 1;
        return { kind: 'session:error', message: event.data?.message };
      }
      default:
        return null;
    }
  }

  static _stats(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    return {
      count: sorted.length,
      avg: Number((sum / sorted.length).toFixed(1)),
      p50: pct(50),
      p95: pct(95),
      max: sorted[sorted.length - 1],
    };
  }

  /** Full usage summary: tokens, tools, skills, models, errors, latency. */
  summary() {
    return {
      tokens: { ...this.tokens },
      apiCalls: this.apiCalls,
      cost: this.cost || null,
      models: Object.fromEntries(this.models),
      tools: Object.fromEntries(
        [...this.tools].map(([name, t]) => [name, {
          ...t,
          avgDurationMs: t.calls ? Number((t.totalDurationMs / t.calls).toFixed(1)) : 0,
        }]),
      ),
      skills: Object.fromEntries(this.skills),
      errors: { ...this.errors },
      latency: {
        ttftMs: UsageTracker._stats(this.latency.ttftMs),
        callDurationMs: UsageTracker._stats(this.latency.callDurationMs),
      },
      contextWindow: this.contextWindow,
    };
  }

  /** Human-readable single-string report. */
  report() {
    const s = this.summary();
    const lines = [
      '=== Copilot Harness Usage Summary ===',
      `tokens: ${s.tokens.total} total (${s.tokens.input} in / ${s.tokens.output} out, ` +
        `${s.tokens.reasoning} reasoning, cache ${s.tokens.cacheRead}r/${s.tokens.cacheWrite}w) ` +
        `across ${s.apiCalls} API call(s)`,
    ];
    if (s.latency.ttftMs) {
      lines.push(`TTFT ms: avg ${s.latency.ttftMs.avg} p95 ${s.latency.ttftMs.p95}`);
    }
    if (s.latency.callDurationMs) {
      lines.push(`call duration ms: avg ${s.latency.callDurationMs.avg} p95 ${s.latency.callDurationMs.p95}`);
    }
    const toolNames = Object.keys(s.tools);
    lines.push(toolNames.length
      ? `tools: ${toolNames.map((n) => {
        const t = s.tools[n];
        return `${n} x${t.calls} (${t.succeeded} ok / ${t.failed} fail, avg ${t.avgDurationMs}ms)`;
      }).join(', ')}`
      : 'tools: none');
    const skillNames = Object.keys(s.skills);
    lines.push(skillNames.length
      ? `skills: ${skillNames.map((n) => `${n} x${s.skills[n]}`).join(', ')}`
      : 'skills: none');
    if (s.errors.providerFailures || s.errors.sessionErrors) {
      lines.push(`errors: ${s.errors.providerFailures} provider (${s.errors.rateLimited} rate-limited), ` +
        `${s.errors.sessionErrors} session`);
    }
    if (s.contextWindow) {
      lines.push(`context window: ${s.contextWindow.currentTokens}/${s.contextWindow.tokenLimit} tokens, ` +
        `${s.contextWindow.messagesLength} messages`);
    }
    return lines.join('\n');
  }
}
