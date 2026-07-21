import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens,
  estimateMessagesTokens,
  TokenBudget,
  TokenBudgetExceededError,
  analyzeRun,
} from '../src/tokens.mjs';

test('estimateTokens scales with input size', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  // max(4 chars / 4, 1 word * 4/3 rounded up) = 2 — the word floor dominates
  assert.equal(estimateTokens('abcd'), 2);
  const tokens = estimateTokens('word '.repeat(100));
  assert.ok(tokens >= 100, `expected >=100, got ${tokens}`);
});

test('estimateMessagesTokens adds per-message overhead', () => {
  const t = estimateMessagesTokens([
    { role: 'user', content: 'abcd' },
    { role: 'assistant', content: 'efgh' },
  ]);
  assert.equal(t, 2 + 4 + 2 + 4);
});

test('TokenBudget: unlimited when maxTokens is null', () => {
  const b = new TokenBudget({});
  assert.equal(b.remaining, Infinity);
  assert.equal(b.record(1_000_000), 'ok');
  assert.equal(b.wouldExceed(1e9), false);
});

test('TokenBudget: warn threshold fires once, then exceeded', () => {
  const b = new TokenBudget({ maxTokens: 100, warnAtPercent: 80 });
  assert.equal(b.record(50), 'ok');
  assert.equal(b.record(35), 'warn');     // 85%
  assert.equal(b.record(5), 'ok');        // warned already
  assert.equal(b.record(20), 'exceeded'); // 110%
  assert.equal(b.remaining, 0);
});

test('TokenBudget.checkOrThrow blocks in block mode, passes in warn mode', () => {
  const block = new TokenBudget({ maxTokens: 100, enforcement: 'block' });
  block.record(90);
  assert.throws(() => block.checkOrThrow(20), TokenBudgetExceededError);
  assert.equal(block.checkOrThrow(5), false);

  const warn = new TokenBudget({ maxTokens: 100, enforcement: 'warn' });
  warn.record(90);
  assert.equal(warn.checkOrThrow(20), true); // exceeded but not thrown
});

test('analyzeRun: breakdown and budget verdict', () => {
  const budget = new TokenBudget({ maxTokens: 100 });
  budget.record(50);
  const report = analyzeRun({
    prompt: 'x'.repeat(80),            // ~20 tokens
    systemPrompt: 'y'.repeat(40),      // ~10 tokens
    context: [{ role: 'user', content: 'z'.repeat(16) }], // 4 + 4 overhead
    attachments: ['a'.repeat(20)],     // 5
    expectedOutputTokens: 50,
  }, budget);

  assert.equal(report.breakdown.promptTokens, 20);
  assert.equal(report.breakdown.systemTokens, 10);
  assert.equal(report.breakdown.contextTokens, 8);
  assert.equal(report.breakdown.attachmentTokens, 5);
  assert.equal(report.estimatedInputTokens, 43);
  assert.equal(report.estimatedTotalTokens, 93);
  assert.equal(report.fitsWithinBudget, false); // 50 used + 93 > 100
  assert.match(report.recommendation, /blocked/);

  const fits = analyzeRun({ prompt: 'short' }, new TokenBudget({ maxTokens: 1000 }));
  assert.equal(fits.fitsWithinBudget, true);
  assert.equal(fits.recommendation, 'ok');
});
