import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  defaultConfig,
  mergeConfig,
  configFromEnv,
  ConfigError,
  resolveSystemPrompt,
} from '../src/config.mjs';

test('defaults: gpt-5-mini at low reasoning effort', () => {
  const cfg = loadConfig({ env: {} });
  assert.equal(cfg.model, 'gpt-5-mini');
  assert.equal(cfg.reasoningEffort, 'low');
  assert.equal(cfg.streaming, false);
  assert.equal(cfg.tokenBudget.maxTokens, null);
  assert.equal(cfg.tokenBudget.enforcement, 'block');
});

test('mergeConfig deep-merges nested objects and replaces scalars/arrays', () => {
  const merged = mergeConfig(
    defaultConfig(),
    { tokenBudget: { maxTokens: 1000 }, cliArgs: ['--a'] },
    { tokenBudget: { warnAtPercent: 50 }, cliArgs: ['--b'] },
  );
  assert.equal(merged.tokenBudget.maxTokens, 1000);
  assert.equal(merged.tokenBudget.warnAtPercent, 50);
  assert.equal(merged.tokenBudget.enforcement, 'block');
  assert.deepEqual(merged.cliArgs, ['--b']);
});

test('environment variables map onto config', () => {
  const layer = configFromEnv({
    COPILOT_CLI_PATH: '/tmp/copilot',
    COPILOT_MODEL: 'gpt-5',
    COPILOT_REASONING_EFFORT: 'medium',
    COPILOT_TOKEN_BUDGET: '5000',
    COPILOT_HARNESS_STORE_DIR: '/tmp/store',
  });
  assert.equal(layer.cliPath, '/tmp/copilot');
  assert.equal(layer.model, 'gpt-5');
  assert.equal(layer.reasoningEffort, 'medium');
  assert.equal(layer.tokenBudget.maxTokens, 5000);
  assert.equal(layer.contextStore.directory, '/tmp/store');
  assert.equal(layer.contextStore.enabled, true);
});

test('overrides win over env and file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'file-model', reasoningEffort: 'high' }));
  const cfg = loadConfig({
    configFile: file,
    env: { COPILOT_MODEL: 'env-model' },
    overrides: { model: 'override-model' },
  });
  assert.equal(cfg.model, 'override-model');
  assert.equal(cfg.reasoningEffort, 'high'); // from file, env didn't set it
});

test('proxy resolution: explicit config beats env; proxyFromEnv picks up HTTPS_PROXY', () => {
  const viaEnv = loadConfig({ env: { HTTPS_PROXY: 'http://proxy:8080' } });
  assert.equal(viaEnv.httpProxy, 'http://proxy:8080');

  const explicit = loadConfig({
    env: { HTTPS_PROXY: 'http://env-proxy:8080' },
    overrides: { httpProxy: 'http://cfg-proxy:9090' },
  });
  assert.equal(explicit.httpProxy, 'http://cfg-proxy:9090');

  const disabled = loadConfig({
    env: { HTTPS_PROXY: 'http://env-proxy:8080' },
    overrides: { proxyFromEnv: false },
  });
  assert.equal(disabled.httpProxy, null);
});

test('validation rejects bad reasoningEffort, budget, enforcement', () => {
  assert.throws(() => loadConfig({ env: {}, overrides: { reasoningEffort: 'max' } }), ConfigError);
  assert.throws(() => loadConfig({ env: {}, overrides: { tokenBudget: { maxTokens: -5 } } }), ConfigError);
  assert.throws(
    () => loadConfig({ env: {}, overrides: { tokenBudget: { enforcement: 'explode' } } }),
    ConfigError,
  );
  assert.throws(
    () => loadConfig({ env: {}, overrides: { systemPromptMode: 'prepend' } }),
    ConfigError,
  );
});

test('invalid config file JSON raises a descriptive error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cfg-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadConfig({ configFile: file, env: {} }), /Invalid JSON/);
  assert.throws(() => loadConfig({ configFile: path.join(dir, 'missing.json'), env: {} }), /Cannot read/);
});

test('resolveSystemPrompt: inline wins, file fallback, null otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sys-'));
  const file = path.join(dir, 'instructions.md');
  fs.writeFileSync(file, '# Be terse\n');

  assert.equal(resolveSystemPrompt({ systemPrompt: 'inline', systemPromptFile: file }), 'inline');
  assert.equal(resolveSystemPrompt({ systemPrompt: null, systemPromptFile: file }), '# Be terse\n');
  assert.equal(resolveSystemPrompt({ systemPrompt: null, systemPromptFile: null }), null);

  const cfg = loadConfig({ env: {}, overrides: { systemPromptFile: file } });
  assert.equal(resolveSystemPrompt(cfg), '# Be terse\n');
});

test('missing systemPromptFile fails validation', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { systemPromptFile: '/nope/does-not-exist.md' } }),
    ConfigError,
  );
});
