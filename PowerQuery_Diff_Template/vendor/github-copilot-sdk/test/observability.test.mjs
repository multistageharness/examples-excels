import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Observability, telemetryConfigFor } from '../src/observability.mjs';

test('telemetryConfigFor maps harness config to SDK TelemetryConfig', () => {
  assert.equal(telemetryConfigFor({ enabled: false, otlpEndpoint: 'http://x' }), undefined);
  assert.equal(telemetryConfigFor(null), undefined);

  const otlp = telemetryConfigFor({
    enabled: true,
    otlpEndpoint: 'http://collector:4318',
    serviceName: 'svc',
    captureContent: true,
  });
  assert.deepEqual(otlp, {
    otlpEndpoint: 'http://collector:4318',
    exporterType: 'otlp-http',
    sourceName: 'svc',
    captureContent: true,
  });

  const file = telemetryConfigFor({ enabled: true, filePath: '/tmp/traces.jsonl' });
  assert.equal(file.exporterType, 'file');
  assert.equal(file.filePath, '/tmp/traces.jsonl');
});

/** Minimal fake @opentelemetry/api capturing instrument writes. */
function fakeOtelApi() {
  const records = { counters: [], histograms: [], gauges: [], spans: [] };
  const meter = {
    createCounter: (name) => ({ add: (v, attrs) => records.counters.push({ name, v, attrs }) }),
    createHistogram: (name) => ({ record: (v, attrs) => records.histograms.push({ name, v, attrs }) }),
    createObservableGauge: (name) => ({
      addCallback: (cb) => records.gauges.push({ name, cb }),
    }),
  };
  const api = {
    records,
    trace: {
      getTracer: () => ({
        startSpan: (name, opts) => {
          const span = { name, attrs: opts?.attributes, events: [], ended: false };
          span.setAttribute = () => {};
          span.setAttributes = () => {};
          span.addEvent = (e) => span.events.push(e);
          span.recordException = (err) => { span.exception = err; };
          span.setStatus = (s) => { span.status = s; };
          span.end = () => { span.ended = true; };
          records.spans.push(span);
          return span;
        },
      }),
      setSpan: (ctx) => ctx,
    },
    metrics: { getMeter: () => meter },
    context: { active: () => ({}), with: (_ctx, fn) => fn() },
    propagation: { inject: (_ctx, carrier) => { carrier.traceparent = '00-abc-def-01'; } },
    SpanStatusCode: { ERROR: 2 },
  };
  return api;
}

test('disabled observability is a complete no-op', async () => {
  const obs = await new Observability({ enabled: false }).init();
  obs.recordRequestStart();
  obs.recordTokens({ inputTokens: 10 });
  obs.recordToolCall({ tool: 't', outcome: 'success' });
  obs.recordError('provider');
  const span = obs.startSpan('x');
  span.end();
  const out = await obs.withSpan('y', {}, async () => 42);
  assert.equal(out, 42);
});

test('golden signals are recorded through the OTel API', async () => {
  const api = fakeOtelApi();
  const obs = await new Observability({ enabled: true, serviceName: 'svc' }, { api }).init();

  obs.recordRequestStart({ model: 'm' });
  obs.recordTokens({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2, model: 'm' });
  obs.recordRequestEnd({ durationMs: 900, ttftMs: 100, model: 'm' });
  obs.recordToolCall({ tool: 'lookup', outcome: 'success', durationMs: 30 });
  obs.recordError('rate_limit', { status: 429 });

  const names = api.records.counters.map((c) => c.name);
  assert.ok(names.includes('copilot_harness.requests'));
  assert.ok(names.includes('copilot_harness.tool.calls'));
  assert.ok(names.includes('copilot_harness.errors'));

  const tokenAdds = api.records.counters.filter((c) => c.name === 'copilot_harness.tokens');
  assert.deepEqual(
    tokenAdds.map((c) => [c.attrs.direction, c.v]).sort(),
    [['input', 10], ['output', 5], ['reasoning', 2]].sort(),
  );

  const histNames = api.records.histograms.map((h) => h.name);
  assert.ok(histNames.includes('copilot_harness.request.duration_ms'));
  assert.ok(histNames.includes('copilot_harness.request.ttft_ms'));
  assert.ok(histNames.includes('copilot_harness.tool.duration_ms'));

  assert.equal(api.records.gauges.length, 2);
});

test('budget and context gauges observe snapshots', async () => {
  const api = fakeOtelApi();
  const obs = await new Observability({ enabled: true }, { api }).init();
  obs.observeBudget({ maxTokens: 100, utilizationPercent: 45 });
  obs.observeContextWindow({ currentTokens: 64, tokenLimit: 128 });

  const observed = [];
  for (const g of api.records.gauges) {
    g.cb({ observe: (v) => observed.push({ name: g.name, v }) });
  }
  assert.deepEqual(observed, [
    { name: 'copilot_harness.budget.utilization', v: 45 },
    { name: 'copilot_harness.context_window.utilization', v: 50 },
  ]);
});

test('withSpan records exceptions and re-throws', async () => {
  const api = fakeOtelApi();
  const obs = await new Observability({ enabled: true }, { api }).init();
  await assert.rejects(
    obs.withSpan('failing', {}, async () => { throw new Error('kaput'); }),
    /kaput/,
  );
  const span = api.records.spans.find((s) => s.name === 'failing');
  assert.equal(span.ended, true);
  assert.match(span.exception.message, /kaput/);
  assert.equal(span.status.code, 2);
});

test('ingest maps usage records onto metrics', async () => {
  const api = fakeOtelApi();
  const obs = await new Observability({ enabled: true }, { api }).init();

  obs.ingest(
    { kind: 'tokens', model: 'm' },
    { data: { inputTokens: 7, outputTokens: 3, duration: 500, timeToFirstTokenMs: 80, model: 'm' } },
  );
  obs.ingest({ kind: 'tool:end', tool: 'shell', success: false, durationMs: 12 });
  obs.ingest({ kind: 'provider:error', status: 429 });
  obs.ingest({ kind: 'provider:error', status: 500 });
  obs.ingest({ kind: 'session:error' });

  const errorKinds = api.records.counters
    .filter((c) => c.name === 'copilot_harness.errors')
    .map((c) => c.attrs.kind);
  assert.deepEqual(errorKinds, ['rate_limit', 'provider', 'session']);

  const toolCall = api.records.counters.find((c) => c.name === 'copilot_harness.tool.calls');
  assert.equal(toolCall.attrs.outcome, 'failure');
});

test('traceContextProvider injects the active context', async () => {
  const api = fakeOtelApi();
  const obs = await new Observability({ enabled: true }, { api }).init();
  const provider = obs.traceContextProvider();
  assert.deepEqual(provider(), { traceparent: '00-abc-def-01' });

  const off = new Observability({ enabled: false });
  assert.equal(off.traceContextProvider(), undefined);
});
