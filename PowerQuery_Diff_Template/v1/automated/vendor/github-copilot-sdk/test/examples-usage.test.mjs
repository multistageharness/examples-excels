// examples-usage.test.mjs — one offline input/output guard test PER example use case.
//
// Added under change record changelogs/.../0001-unit-test-per-use-case (Amendment A1 + Addendum
// D1): the plan's "no new unit tests in test/**" exclusion is narrowed to allow CI-safe guard
// tests that need NO Copilot auth, network, or live CLI.
//
// Three contract classes, all observable offline:
//   • prompt-guard examples  — no prompt → `requirePrompt` prints usage + exit 2 BEFORE the
//                              harness is created (0 tokens, nothing spawned).
//   • 03-sse-server          — starts a node:http server, prints a startup banner, then listens
//                              (createHarness is lazy → no CLI spawn until a request); we assert
//                              the banner and kill it.
//   • 23-repl-chatbot        — interactive; stdin EOF → banner + usage summary + exit 0.
//
// Run:  npm test   (matches "test/*.test.mjs")   ·   or  node --test test/examples-usage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const SPAWN_TIMEOUT_MS = 30_000;

// Examples whose offline contract is NOT the prompt-guard (handled by bespoke tests below).
const SERVER_EXAMPLE = '03-sse-server.mjs';
const REPL_EXAMPLE = '23-repl-chatbot.mjs';
const SSE_PORT = '39117';

// Discover every runnable example use case (NN-name.mjs), excluding the shared bootstrap.
function exampleFiles() {
  return fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => /^\d.*\.mjs$/.test(f))
    .sort();
}

function runExampleSync(file, { input, env } = {}) {
  return spawnSync('node', [path.join(EXAMPLES_DIR, file)], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    input: input ?? undefined,
    env: { ...process.env, ...env },
  });
}

// ── prompt-guard use cases: no prompt → usage hint + exit 2, runtime never spawned ──
const guardExamples = exampleFiles().filter((f) => f !== SERVER_EXAMPLE && f !== REPL_EXAMPLE);

for (const file of guardExamples) {
  test(`${file}: no prompt → usage guard, exit 2, 0 tokens`, () => {
    const r = runExampleSync(file, { input: '' });
    assert.equal(r.signal, null, `should not be killed by timeout (signal=${r.signal})`);
    assert.equal(r.status, 2, `exit code 2 (got ${r.status}); stderr=${r.stderr}`);
    assert.match(
      r.stderr,
      /No message provided — nothing sent to the model \(0 tokens spent\)\./,
      'prints the 0-tokens guard line',
    );
    // Usage line names THIS example's own file — proves the guard wiring per example.
    assert.ok(
      r.stderr.includes(`Usage: node examples/${file}`),
      `Usage line references ${file}; stderr=${r.stderr}`,
    );
  });
}

// ── 23-repl-chatbot: stdin EOF → banner + usage summary, exit 0 (no chat() → no spawn) ──
test(`${REPL_EXAMPLE}: stdin EOF → banner + usage summary, exit 0`, () => {
  const r = runExampleSync(REPL_EXAMPLE, { input: '' });
  assert.equal(r.signal, null, `should exit on its own (signal=${r.signal})`);
  assert.equal(r.status, 0, `exit 0 on EOF (got ${r.status}); stderr=${r.stderr}`);
  assert.match(r.stderr, /Interactive chat — type "exit" or "quit"/, 'prints the interactive banner');
  assert.match(r.stdout, /Usage Summary/, 'prints a usage summary on the way out');
});

// ── 03-sse-server: starts, prints startup banner, then listens; assert banner + kill ──
test(`${SERVER_EXAMPLE}: starts and prints the SSE startup banner`, async () => {
  await new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(EXAMPLES_DIR, SERVER_EXAMPLE)], {
      env: { ...process.env, PORT: SSE_PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch { /* already gone */ }
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(
      () => done(new Error(`no banner within timeout; stdout so far: ${out}`)),
      SPAWN_TIMEOUT_MS,
    );
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes(`SSE server on :${SSE_PORT}`)) {
        try {
          assert.match(out, new RegExp(`SSE server on :${SSE_PORT} — curl`));
          done();
        } catch (e) {
          done(e);
        }
      }
    });
    child.on('error', done);
    child.on('exit', (code, signal) => {
      // Exiting before the banner (and not via our SIGTERM) is a failure.
      if (!settled) done(new Error(`server exited early code=${code} signal=${signal}; stdout: ${out}`));
    });
  });
});
