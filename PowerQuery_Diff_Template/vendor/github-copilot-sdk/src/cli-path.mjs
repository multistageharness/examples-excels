/**
 * CLI path resolution for the GitHub Copilot CLI.
 *
 * The Copilot SDK shells out to the `@github/copilot` CLI at runtime, so the
 * harness needs a deterministic way to locate it. Resolution precedence:
 *
 *   1. Explicit `cliPath` from harness config (the CLI_PATH arg).
 *   2. `COPILOT_CLI_PATH` env var.
 *   3. Native module resolution of `@github/copilot*` (createRequire /
 *      import.meta.resolve), anchored at a configurable directory.
 *   4. Manual `node_modules` walk up the directory tree.
 *
 * Strategies 3-4 are adapted from
 * https://github.com/carlosmarte/findCopilotNodeModuleDirectoryPath
 * (packages/mjs), vendored here so the harness has zero extra dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Candidate package names, most specific first. */
export const DEFAULT_CANDIDATES = [
  '@github/copilot',
  '@github/copilot-sdk',
  '@github/copilot-language-server',
];

/**
 * Error codes meaning "Node produced no entry path" — package absent, or
 * installed but its `exports` map blocks resolution (e.g. `@github/copilot`
 * exposes no `.` export). All degrade to the manual walk instead of throwing.
 */
const NOT_RESOLVABLE = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_UNSUPPORTED_DIR_IMPORT',
]);

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Best-effort entry file for a package whose `exports` blocks native
 * resolution: read its package.json and probe main / module / bin / index.js.
 * @param {string} dir package root
 * @returns {string|null}
 */
export function readManifestEntry(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const rels = [];
    if (typeof pkg.main === 'string') rels.push(pkg.main);
    if (typeof pkg.module === 'string') rels.push(pkg.module);
    if (typeof pkg.bin === 'string') rels.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === 'object') {
      const first = Object.values(pkg.bin).find((v) => typeof v === 'string');
      if (first) rels.push(first);
    }
    rels.push('index.js');
    for (const rel of rels) {
      const abs = path.join(dir, rel);
      if (isFile(abs)) return abs;
    }
  } catch {
    // missing/unreadable manifest — fall through
  }
  return null;
}

/**
 * Resolve a module's entry file natively, anchored at `fromDir`.
 * @param {string} moduleName
 * @param {{ fromDir?: string }} [opts]
 * @returns {string|null}
 */
export function resolveModuleEntry(moduleName, opts = {}) {
  const fromDir = path.resolve(opts.fromDir || process.cwd());
  // createRequire wants a file path to anchor resolution; the file need not
  // exist — only its directory is used as the lookup base.
  const require = createRequire(path.join(fromDir, 'noop.cjs'));
  try {
    return require.resolve(moduleName);
  } catch (err) {
    if (err && NOT_RESOLVABLE.has(err.code)) return null;
    throw err;
  }
}

/**
 * Derive the package root directory from a resolved entry file.
 * @param {string} moduleName
 * @param {string|null} entry
 * @param {{ fromDir?: string }} [opts]
 * @returns {string|null}
 */
export function packageRootFromEntry(moduleName, entry, opts = {}) {
  if (!entry) return null;
  const marker = path.join('node_modules', ...moduleName.split('/'));
  const idx = entry.lastIndexOf(marker);
  if (idx !== -1) return entry.slice(0, idx + marker.length);
  try {
    const fromDir = path.resolve(opts.fromDir || process.cwd());
    const require = createRequire(path.join(fromDir, 'noop.cjs'));
    return path.dirname(require.resolve(`${moduleName}/package.json`));
  } catch {
    return null;
  }
}

/**
 * Manually walk up the directory tree looking for `node_modules/<name>`.
 * @param {string} moduleName
 * @param {{ fromDir?: string }} [opts]
 * @returns {string|null}
 */
export function findClosestModuleDir(moduleName, opts = {}) {
  const segments = moduleName.split('/');
  let dir = path.resolve(opts.fromDir || process.cwd());
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, 'node_modules', ...segments);
    if (isDir(candidate)) return candidate;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

/**
 * Find the closest installed copilot module across the candidate list.
 * @param {{ candidates?: string|string[], fromDir?: string, strategy?: 'auto'|'native'|'manual' }} [opts]
 * @returns {{ name: string, dir: string|null, entry: string|null, strategy: 'native'|'manual', fromDir: string }|null}
 */
export function findCopilot(opts = {}) {
  const fromDir = path.resolve(opts.fromDir || process.cwd());
  const strategy = opts.strategy || 'auto';
  const list = opts.candidates
    ? (Array.isArray(opts.candidates) ? opts.candidates : [opts.candidates])
    : DEFAULT_CANDIDATES;

  for (const name of list) {
    if (strategy === 'auto' || strategy === 'native') {
      const entry = resolveModuleEntry(name, { fromDir });
      if (entry) {
        return {
          name,
          dir: packageRootFromEntry(name, entry, { fromDir }),
          entry,
          strategy: 'native',
          fromDir,
        };
      }
    }
    if (strategy === 'auto' || strategy === 'manual') {
      const dir = findClosestModuleDir(name, { fromDir });
      if (dir) {
        return { name, dir, entry: readManifestEntry(dir), strategy: 'manual', fromDir };
      }
    }
  }
  return null;
}

/**
 * Resolve the Copilot CLI entry point using the full precedence chain.
 *
 * @param {object} [opts]
 * @param {string} [opts.cliPath]   Explicit path (highest precedence). Validated.
 * @param {string} [opts.fromDir]   Anchor directory for module resolution.
 * @param {NodeJS.ProcessEnv} [opts.env] Env to consult (default process.env).
 * @param {boolean} [opts.required] Throw when nothing resolves (default true).
 * @returns {string|null} absolute path to the CLI entry, or null when
 *   `required: false` and nothing was found.
 */
export function resolveCliPath(opts = {}) {
  const { cliPath, fromDir, env = process.env, required = true } = opts;

  if (cliPath) {
    if (!isFile(cliPath)) {
      throw new Error(`cliPath does not exist or is not a file: ${cliPath}`);
    }
    return path.resolve(cliPath);
  }

  if (env.COPILOT_CLI_PATH) {
    if (!isFile(env.COPILOT_CLI_PATH)) {
      throw new Error(
        `COPILOT_CLI_PATH does not exist or is not a file: ${env.COPILOT_CLI_PATH}`,
      );
    }
    return path.resolve(env.COPILOT_CLI_PATH);
  }

  // Prefer resolving relative to this module first (works when the harness is
  // installed as a dependency next to @github/copilot), then the caller's dir.
  const hereDir = path.dirname(fileURLToPath(import.meta.url));
  for (const anchor of [fromDir, hereDir, process.cwd()].filter(Boolean)) {
    const found = findCopilot({ candidates: ['@github/copilot'], fromDir: anchor });
    if (found?.entry) return found.entry;
  }

  if (required) {
    throw new Error(
      'GitHub Copilot CLI not found. Install @github/copilot, set COPILOT_CLI_PATH, ' +
      'or pass cliPath in the harness config.',
    );
  }
  return null;
}
