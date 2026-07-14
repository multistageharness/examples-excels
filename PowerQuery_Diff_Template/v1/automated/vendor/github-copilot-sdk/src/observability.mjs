/**
 * SRE observability for the harness, built on OpenTelemetry.
 *
 * Two layers:
 *
 * 1. CLI-runtime telemetry — the Copilot CLI has native OTel support. The
 *    harness translates `config.observability` into the SDK's
 *    `TelemetryConfig` (OTLP endpoint / file exporter env vars on the
 *    spawned runtime) so CLI-side traces flow to your APM backend, and
 *    wires `onGetTraceContext` so harness spans and CLI spans share one
 *    distributed trace.
 *
 * 2. Harness-side golden signals — emitted via `@opentelemetry/api` when it
 *    is installed (optional peer dep); everything degrades to no-ops when
 *    it isn't, so the harness has zero hard observability dependencies.
 *
 * Golden signals covered:
 *   - Latency:    copilot_harness.request.duration_ms (histogram)
 *                 copilot_harness.request.ttft_ms     (histogram, streaming)
 *   - Traffic:    copilot_harness.tokens (counter, attr direction=input|output|reasoning)
 *                 copilot_harness.requests (counter)
 *   - Errors:     copilot_harness.errors (counter, attr kind=provider|rate_limit|session|harness)
 *   - Saturation: copilot_harness.budget.utilization (gauge via observable callback)
 *                 copilot_harness.context_window.utilization (gauge)
 *   - Tools/MCP:  copilot_harness.tool.calls (counter, attrs tool, outcome)
 *                 copilot_harness.tool.duration_ms (histogram, attr tool)
 */

let otelApi = null;
let otelLoadAttempted = false;

/** Load @opentelemetry/api if present. Cached after first attempt. */
export async function loadOtelApi() {
  if (otelLoadAttempted) return otelApi;
  otelLoadAttempted = true;
  try {
    otelApi = await import('@opentelemetry/api');
  } catch {
    otelApi = null;
  }
  return otelApi;
}

/** test seam */
export function _setOtelApiForTests(api) {
  otelApi = api;
  otelLoadAttempted = true;
}

/** Translate harness observability config into the SDK TelemetryConfig. */
export function telemetryConfigFor(obsConfig) {
  if (!obsConfig?.enabled) return undefined;
  const cfg = {};
  if (obsConfig.otlpEndpoint) {
    cfg.otlpEndpoint = obsConfig.otlpEndpoint;
    cfg.exporterType = obsConfig.exporterType ?? 'otlp-http';
  }
  if (obsConfig.filePath) {
    cfg.filePath = obsConfig.filePath;
    cfg.exporterType = obsConfig.exporterType ?? 'file';
  }
  if (obsConfig.sourceName ?? obsConfig.serviceName) {
    cfg.sourceName = obsConfig.sourceName ?? obsConfig.serviceName;
  }
  if (obsConfig.captureContent != null) cfg.captureContent = obsConfig.captureContent;
  return Object.keys(cfg).length ? cfg : undefined;
}

const noop = () => {};
const NOOP_SPAN = {
  setAttribute: noop,
  setAttributes: noop,
  addEvent: noop,
  recordException: noop,
  setStatus: noop,
  end: noop,
};

export class Observability {
  /**
   * @param {object} obsConfig harness `config.observability`
   * @param {object} [deps] injected for tests: { api }
   */
  constructor(obsConfig = {}, deps = {}) {
    this.config = obsConfig;
    this.enabled = !!obsConfig.enabled;
    this._api = deps.api ?? null;
    this._tracer = null;
    this._instruments = null;
    this._budgetSnapshot = null;
    this._contextSnapshot = null;
  }

  /** Initialize tracer/meter. Safe to call when OTel is absent. */
  async init() {
    if (!this.enabled) return this;
    const api = this._api ?? await loadOtelApi();
    if (!api) return this; // enabled but no OTel API installed → no-op metrics
    this._api = api;
    const name = this.config.serviceName ?? 'copilot-sdk-harness';
    this._tracer = api.trace.getTracer(name);
    const meter = api.metrics.getMeter(name);
    this._instruments = {
      requests: meter.createCounter('copilot_harness.requests', {
        description: 'Copilot harness requests started',
      }),
      tokens: meter.createCounter('copilot_harness.tokens', {
        description: 'Tokens consumed, attr direction=input|output|reasoning|cache_read|cache_write',
      }),
      errors: meter.createCounter('copilot_harness.errors', {
        description: 'Errors, attr kind=provider|rate_limit|session|harness',
      }),
      duration: meter.createHistogram('copilot_harness.request.duration_ms', {
        description: 'Total request latency in ms',
        unit: 'ms',
      }),
      ttft: meter.createHistogram('copilot_harness.request.ttft_ms', {
        description: 'Time to first token in ms',
        unit: 'ms',
      }),
      toolCalls: meter.createCounter('copilot_harness.tool.calls', {
        description: 'Tool/MCP executions, attrs tool, outcome=success|failure|denied',
      }),
      toolDuration: meter.createHistogram('copilot_harness.tool.duration_ms', {
        description: 'Tool/MCP execution latency in ms',
        unit: 'ms',
      }),
    };
    meter.createObservableGauge('copilot_harness.budget.utilization', {
      description: 'Token budget utilization percent',
    }).addCallback((observable) => {
      if (this._budgetSnapshot?.maxTokens != null) {
        observable.observe(this._budgetSnapshot.utilizationPercent);
      }
    });
    meter.createObservableGauge('copilot_harness.context_window.utilization', {
      description: 'Context window utilization percent',
    }).addCallback((observable) => {
      const cw = this._contextSnapshot;
      if (cw?.tokenLimit) observable.observe((cw.currentTokens / cw.tokenLimit) * 100);
    });
    return this;
  }

  /**
   * `onGetTraceContext` provider for CopilotClient — propagates the active
   * harness span context into the CLI runtime so both sides share a trace.
   */
  traceContextProvider() {
    if (!this._api) return undefined;
    const api = this._api;
    return () => {
      const carrier = {};
      api.propagation.inject(api.context.active(), carrier);
      return carrier;
    };
  }

  /** Start a span (no-op span when tracing is unavailable). */
  startSpan(name, attributes = {}) {
    if (!this._tracer) return NOOP_SPAN;
    return this._tracer.startSpan(name, { attributes });
  }

  /** Run `fn` inside a span, recording exceptions and ending it. */
  async withSpan(name, attributes, fn) {
    const span = this.startSpan(name, attributes);
    if (!this._api || span === NOOP_SPAN) {
      try {
        return await fn(span);
      } finally {
        span.end();
      }
    }
    const api = this._api;
    const ctx = api.trace.setSpan(api.context.active(), span);
    try {
      return await api.context.with(ctx, () => fn(span));
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: String(err?.message ?? err) });
      throw err;
    } finally {
      span.end();
    }
  }

  recordRequestStart(attrs = {}) {
    this._instruments?.requests.add(1, attrs);
  }

  recordRequestEnd({ durationMs, ttftMs, model } = {}) {
    if (!this._instruments) return;
    const attrs = model ? { model } : {};
    if (durationMs != null) this._instruments.duration.record(durationMs, attrs);
    if (ttftMs != null) this._instruments.ttft.record(ttftMs, attrs);
  }

  recordTokens({ inputTokens = 0, outputTokens = 0, reasoningTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, model } = {}) {
    if (!this._instruments) return;
    const base = model ? { model } : {};
    const add = (n, direction) => {
      if (n > 0) this._instruments.tokens.add(n, { ...base, direction });
    };
    add(inputTokens, 'input');
    add(outputTokens, 'output');
    add(reasoningTokens, 'reasoning');
    add(cacheReadTokens, 'cache_read');
    add(cacheWriteTokens, 'cache_write');
  }

  recordToolCall({ tool, outcome, durationMs } = {}) {
    if (!this._instruments) return;
    this._instruments.toolCalls.add(1, { tool, outcome });
    if (durationMs != null) this._instruments.toolDuration.record(durationMs, { tool });
  }

  recordError(kind, attrs = {}) {
    this._instruments?.errors.add(1, { kind, ...attrs });
  }

  /** Keep gauges fresh. */
  observeBudget(snapshot) {
    this._budgetSnapshot = snapshot;
  }

  observeContextWindow(usageInfo) {
    this._contextSnapshot = usageInfo;
  }

  /**
   * Ingest a normalized usage record (output of UsageTracker.ingestEvent)
   * so golden signals stay in sync with the SDK event stream.
   */
  ingest(record, rawEvent) {
    if (!record) return;
    switch (record.kind) {
      case 'tokens':
        this.recordTokens(rawEvent?.data ?? record);
        this.recordRequestEnd({
          durationMs: rawEvent?.data?.duration,
          ttftMs: rawEvent?.data?.timeToFirstTokenMs,
          model: record.model,
        });
        break;
      case 'tool:end':
        this.recordToolCall({
          tool: record.tool,
          outcome: record.success ? 'success' : 'failure',
          durationMs: record.durationMs,
        });
        break;
      case 'provider:error':
        this.recordError(record.status === 429 ? 'rate_limit' : 'provider', {
          status: record.status ?? 'unknown',
        });
        break;
      case 'session:error':
        this.recordError('session');
        break;
      case 'context':
        this.observeContextWindow(rawEvent?.data ?? record);
        break;
      default:
        break;
    }
  }
}
