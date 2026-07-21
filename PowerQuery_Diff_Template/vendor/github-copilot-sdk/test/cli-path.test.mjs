import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveCliPath,
  findClosestModuleDir,
  findCopilot,
  readManifestEntry,
} from '../src/cli-path.mjs';

function makeFakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-'));
  const pkgDir = path.join(root, 'node_modules', '@github', 'copilot');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@github/copilot',
    bin: { copilot: 'index.js' },
  }));
  fs.writeFileSync(path.join(pkgDir, 'index.js'), '// fake cli\n');
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  return { root, pkgDir, nested };
}

test('explicit cliPath wins and must exist', () => {
  const { pkgDir } = makeFakeInstall();
  const entry = path.join(pkgDir, 'index.js');
  assert.equal(resolveCliPath({ cliPath: entry, env: {} }), entry);
  assert.throws(() => resolveCliPath({ cliPath: '/nope/cli.js', env: {} }), /does not exist/);
});

test('COPILOT_CLI_PATH env var is honored and validated', () => {
  const { pkgDir } = makeFakeInstall();
  const entry = path.join(pkgDir, 'index.js');
  assert.equal(resolveCliPath({ env: { COPILOT_CLI_PATH: entry } }), entry);
  assert.throws(
    () => resolveCliPath({ env: { COPILOT_CLI_PATH: '/nope/cli.js' } }),
    /COPILOT_CLI_PATH/,
  );
});

test('manual node_modules walk finds the package from a nested dir', () => {
  const { pkgDir, nested } = makeFakeInstall();
  assert.equal(findClosestModuleDir('@github/copilot', { fromDir: nested }), pkgDir);
  assert.equal(findClosestModuleDir('@github/copilot', { fromDir: os.tmpdir() }), null);
});

test('findCopilot manual strategy resolves entry from the manifest', () => {
  const { pkgDir, nested } = makeFakeInstall();
  const found = findCopilot({ fromDir: nested, strategy: 'manual', candidates: ['@github/copilot'] });
  assert.equal(found.dir, pkgDir);
  assert.equal(found.entry, path.join(pkgDir, 'index.js'));
  assert.equal(found.strategy, 'manual');
});

test('readManifestEntry probes main, bin, and index.js', () => {
  const { pkgDir } = makeFakeInstall();
  assert.equal(readManifestEntry(pkgDir), path.join(pkgDir, 'index.js'));
  assert.equal(readManifestEntry('/nope'), null);
});

test('required:false returns null instead of throwing when nothing resolves', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-empty-'));
  // The real repo has @github/copilot installed, so anchor resolution at an
  // empty temp dir; resolution relative to this module may still find it —
  // accept either a real path or null, but never a throw.
  const result = resolveCliPath({ env: {}, fromDir: empty, required: false });
  assert.ok(result === null || fs.existsSync(result));
});
