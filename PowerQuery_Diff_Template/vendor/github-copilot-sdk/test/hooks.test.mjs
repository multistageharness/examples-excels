import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HookManager, HOOK_NAMES } from '../src/hooks.mjs';

test('register/run preserves order and passes payload', async () => {
  const hooks = new HookManager();
  const calls = [];
  hooks.register('beforeRun', (p) => calls.push(['a', p.prompt]));
  hooks.register('beforeRun', (p) => calls.push(['b', p.prompt]));
  await hooks.run('beforeRun', { prompt: 'hi' });
  assert.deepEqual(calls, [['a', 'hi'], ['b', 'hi']]);
});

test('unsubscribe removes the handler', async () => {
  const hooks = new HookManager();
  let count = 0;
  const off = hooks.register('afterRun', () => { count += 1; });
  await hooks.run('afterRun', {});
  off();
  await hooks.run('afterRun', {});
  assert.equal(count, 1);
  assert.equal(hooks.count('afterRun'), 0);
});

test('unknown hook name and non-function handler throw', () => {
  const hooks = new HookManager();
  assert.throws(() => hooks.register('notAHook', () => {}), /Unknown hook/);
  assert.throws(() => hooks.register('beforeRun', 'nope'), TypeError);
});

test('constructor accepts initial handlers, single or array', async () => {
  let hits = 0;
  const hooks = new HookManager({
    beforeRun: () => { hits += 1; },
    afterRun: [() => { hits += 1; }, () => { hits += 1; }],
  });
  await hooks.run('beforeRun', {});
  await hooks.run('afterRun', {});
  assert.equal(hits, 3);
});

test('beforeRun errors propagate; observe-only hook errors are swallowed', async () => {
  const hooks = new HookManager();
  hooks.register('beforeRun', () => { throw new Error('abort run'); });
  await assert.rejects(hooks.run('beforeRun', {}), /abort run/);

  hooks.register('onError', () => { throw new Error('observer bug'); });
  const results = await hooks.run('onError', {});
  assert.equal(results.length, 1);
  assert.match(results[0].hookError.message, /observer bug/);
});

test('toolCallVerdict: first deny wins, allow otherwise', async () => {
  const hooks = new HookManager();
  hooks.register('beforeToolCall', () => undefined);
  assert.deepEqual(await hooks.toolCallVerdict({}), { deny: false });

  hooks.register('beforeToolCall', ({ toolName }) => (
    toolName === 'shell' ? { deny: true, reason: 'no shell' } : undefined
  ));
  const verdict = await hooks.toolCallVerdict({ toolName: 'shell' });
  assert.equal(verdict.deny, true);
  assert.equal(verdict.reason, 'no shell');
  assert.deepEqual(await hooks.toolCallVerdict({ toolName: 'web' }), { deny: false });
});

test('HOOK_NAMES covers the documented lifecycle', () => {
  for (const name of ['beforeRun', 'afterRun', 'beforeToolCall', 'afterToolCall',
    'onToolFailure', 'onPromptSubmit', 'onSessionStart', 'onSessionEnd',
    'onError', 'onBudgetWarning', 'onBudgetExceeded']) {
    assert.ok(HOOK_NAMES.includes(name), `${name} missing`);
  }
});
