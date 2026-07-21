import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ContextStore } from '../src/store.mjs';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-store-'));
  return new ContextStore({ directory: dir });
}

test('requires a directory', () => {
  assert.throws(() => new ContextStore({}), /directory/);
});

test('saveExchange appends JSONL and maintains meta', () => {
  const store = tmpStore();
  store.saveExchange('s1', {
    request: { prompt: 'q1' },
    response: { content: 'a1' },
    usage: { totalTokens: 12 },
    meta: { model: 'gpt-5-mini' },
  });
  store.saveExchange('s1', { request: { prompt: 'q2' }, response: { content: 'a2' } });

  const exchanges = store.load('s1');
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].request.prompt, 'q1');
  assert.equal(exchanges[1].response.content, 'a2');

  const meta = store.meta('s1');
  assert.equal(meta.exchanges, 2);
  assert.equal(meta.model, 'gpt-5-mini');
  assert.ok(meta.updatedAt >= meta.createdAt);
});

test('load returns [] for unknown session; meta returns null', () => {
  const store = tmpStore();
  assert.deepEqual(store.load('nope'), []);
  assert.equal(store.meta('nope'), null);
});

test('list orders by recency and latestSessionId picks newest', async () => {
  const store = tmpStore();
  store.saveExchange('old', { request: { prompt: 'a' }, response: { content: 'b' } });
  await new Promise((r) => { setTimeout(r, 5); });
  store.saveExchange('new', { request: { prompt: 'c' }, response: { content: 'd' } });

  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].sessionId, 'new');
  assert.equal(store.latestSessionId(), 'new');
});

test('asContextMessages converts exchanges into role/content pairs', () => {
  const store = tmpStore();
  store.saveExchange('s', { request: { prompt: 'hello' }, response: { content: 'hi there' } });
  store.saveExchange('s', { request: { prompt: 'more' }, response: { content: null } });

  assert.deepEqual(store.asContextMessages('s'), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'more' },
  ]);
});

test('session ids are sanitized for the filesystem', () => {
  const store = tmpStore();
  store.saveExchange('../evil/../../id', { request: { prompt: 'p' }, response: { content: 'r' } });
  const files = fs.readdirSync(store.directory);
  assert.ok(files.every((f) => !f.includes('/') && !f.startsWith('.')), files.join(','));
  assert.equal(store.load('../evil/../../id').length, 1);
});

test('remove deletes both files', () => {
  const store = tmpStore();
  store.saveExchange('gone', { request: { prompt: 'p' }, response: { content: 'r' } });
  store.remove('gone');
  assert.deepEqual(store.load('gone'), []);
  assert.equal(store.meta('gone'), null);
  store.remove('never-existed'); // no throw
});
