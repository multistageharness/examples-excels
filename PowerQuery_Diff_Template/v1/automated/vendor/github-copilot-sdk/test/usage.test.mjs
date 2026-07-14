import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsageTracker } from '../src/usage.mjs';

function ev(type, data, extra = {}) {
  return { id: 'e1', parentId: null, timestamp: new Date().toISOString(), type, data, ...extra };
}

test('aggregates token usage across assistant.usage events', () => {
  const u = new UsageTracker();
  u.ingestEvent(ev('assistant.usage', {
    model: 'gpt-5-mini', inputTokens: 100, outputTokens: 20,
    reasoningTokens: 5, cacheReadTokens: 50, cacheWriteTokens: 10,
    duration: 800, timeToFirstTokenMs: 120,
  }));
  u.ingestEvent(ev('assistant.usage', {
    model: 'gpt-5-mini', inputTokens: 200, outputTokens: 40, duration: 1000, timeToFirstTokenMs: 80,
  }));

  const s = u.summary();
  assert.equal(s.tokens.input, 300);
  assert.equal(s.tokens.output, 60);
  assert.equal(s.tokens.total, 360);
  assert.equal(s.tokens.reasoning, 5);
  assert.equal(s.tokens.cacheRead, 50);
  assert.equal(s.apiCalls, 2);
  assert.equal(s.models['gpt-5-mini'].calls, 2);
  assert.equal(s.models['gpt-5-mini'].inputTokens, 300);
  assert.equal(s.latency.ttftMs.count, 2);
  assert.equal(s.latency.ttftMs.max, 120);
});

test('tool execution start/complete pairs track success, failure, duration', () => {
  const u = new UsageTracker();
  const t0 = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const t1 = new Date('2026-01-01T00:00:01.500Z').toISOString();

  u.ingestEvent({ ...ev('tool.execution_start', { toolName: 'lookup', toolCallId: 'c1' }), timestamp: t0 });
  const end = u.ingestEvent({
    ...ev('tool.execution_complete', { toolCallId: 'c1', success: true }),
    timestamp: t1,
  });
  assert.equal(end.kind, 'tool:end');
  assert.equal(end.durationMs, 1500);

  u.ingestEvent(ev('tool.execution_start', { toolName: 'lookup', toolCallId: 'c2' }));
  u.ingestEvent(ev('tool.execution_complete', {
    toolCallId: 'c2', success: false, error: { message: 'boom' },
  }));

  const s = u.summary();
  assert.equal(s.tools.lookup.calls, 2);
  assert.equal(s.tools.lookup.succeeded, 1);
  assert.equal(s.tools.lookup.failed, 1);
});

test('complete without start still counts the call', () => {
  const u = new UsageTracker();
  u.ingestEvent(ev('tool.execution_complete', {
    toolCallId: 'orphan', success: true, toolDescription: { name: 'shell' },
  }));
  assert.equal(u.summary().tools.shell.calls, 1);
});

test('skills, provider failures, and rate limiting are counted', () => {
  const u = new UsageTracker();
  u.ingestEvent(ev('skill.invoked', { name: 'changelog' }));
  u.ingestEvent(ev('skill.invoked', { name: 'changelog' }));
  u.ingestEvent(ev('model.call_failure', { statusCode: 429, message: 'Too Many Requests' }));
  u.ingestEvent(ev('model.call_failure', { message: 'internal error' }));
  u.ingestEvent(ev('session.error', { message: 'fatal' }));

  const s = u.summary();
  assert.equal(s.skills.changelog, 2);
  assert.equal(s.errors.providerFailures, 2);
  assert.equal(s.errors.rateLimited, 1);
  assert.equal(s.errors.sessionErrors, 1);
});

test('context window snapshot is kept and reported', () => {
  const u = new UsageTracker();
  u.ingestEvent(ev('session.usage_info', {
    currentTokens: 5000, tokenLimit: 128000, messagesLength: 12,
  }));
  assert.equal(u.summary().contextWindow.currentTokens, 5000);
  assert.match(u.report(), /context window: 5000\/128000 tokens/);
});

test('report renders a readable multi-line summary', () => {
  const u = new UsageTracker();
  u.ingestEvent(ev('assistant.usage', { model: 'm', inputTokens: 10, outputTokens: 2 }));
  u.ingestEvent(ev('skill.invoked', { name: 's1' }));
  const report = u.report();
  assert.match(report, /tokens: 12 total \(10 in \/ 2 out/);
  assert.match(report, /skills: s1 x1/);
  assert.match(report, /tools: none/);
});

test('unknown events are ignored', () => {
  const u = new UsageTracker();
  assert.equal(u.ingestEvent(ev('assistant.turn_start', {})), null);
  assert.equal(u.ingestEvent(null), null);
});
