/**
 * Filesystem persistence of the context window (request/response exchanges).
 *
 * Layout under the configured directory:
 *   <dir>/<sessionId>.jsonl      — one JSON line per exchange (append-only)
 *   <dir>/<sessionId>.meta.json  — session metadata (model, timestamps, counts)
 *
 * The store is what lets a caller attach a prior conversation and continue
 * it later: `load()` returns the exchanges, `asContextMessages()` converts
 * them to {role, content} pairs the harness can replay into a new session,
 * and the recorded `sessionId` can be passed to `harness.resumeSession()`
 * when the underlying CLI session still exists on disk.
 */

import fs from 'node:fs';
import path from 'node:path';

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_');
}

export class ContextStore {
  /** @param {{ directory: string }} opts */
  constructor(opts = {}) {
    if (!opts.directory) throw new Error('ContextStore requires a directory');
    this.directory = path.resolve(opts.directory);
  }

  _ensureDir() {
    fs.mkdirSync(this.directory, { recursive: true });
  }

  _file(sessionId, ext) {
    return path.join(this.directory, `${sanitizeId(sessionId)}${ext}`);
  }

  /**
   * Append one request/response exchange for a session.
   * @param {string} sessionId
   * @param {object} exchange { request, response, usage?, meta? }
   */
  saveExchange(sessionId, exchange) {
    this._ensureDir();
    const record = {
      timestamp: new Date().toISOString(),
      request: exchange.request ?? null,
      response: exchange.response ?? null,
      usage: exchange.usage ?? null,
      meta: exchange.meta ?? null,
    };
    fs.appendFileSync(this._file(sessionId, '.jsonl'), `${JSON.stringify(record)}\n`);

    const metaPath = this._file(sessionId, '.meta.json');
    let meta = { sessionId, createdAt: record.timestamp, exchanges: 0 };
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      // first write for this session
    }
    meta.exchanges = (meta.exchanges ?? 0) + 1;
    meta.updatedAt = record.timestamp;
    if (exchange.meta?.model) meta.model = exchange.meta.model;
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    return record;
  }

  /** Load all exchanges for a session (empty array when none). */
  load(sessionId) {
    const file = this._file(sessionId, '.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /** Read session metadata, or null. */
  meta(sessionId) {
    try {
      return JSON.parse(fs.readFileSync(this._file(sessionId, '.meta.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** List stored sessions, most recently updated first. */
  list() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.directory, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** Most recently updated stored session id, or null. */
  latestSessionId() {
    return this.list()[0]?.sessionId ?? null;
  }

  /**
   * Convert stored exchanges into alternating {role, content} messages
   * suitable for `harness.chat(prompt, { context })` replay.
   */
  asContextMessages(sessionId) {
    const messages = [];
    for (const ex of this.load(sessionId)) {
      if (ex.request?.prompt) messages.push({ role: 'user', content: ex.request.prompt });
      if (ex.response?.content) messages.push({ role: 'assistant', content: ex.response.content });
    }
    return messages;
  }

  /** Permanently delete a stored session's files. */
  remove(sessionId) {
    for (const ext of ['.jsonl', '.meta.json']) {
      try {
        fs.unlinkSync(this._file(sessionId, ext));
      } catch {
        // already gone
      }
    }
  }
}
