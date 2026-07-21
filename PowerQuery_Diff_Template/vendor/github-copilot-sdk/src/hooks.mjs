/**
 * Lifecycle hooks for the harness.
 *
 * Hooks are awaited, run in registration order, and can influence execution
 * (e.g. a `beforeToolCall` hook returning `{ deny: true }` blocks the tool).
 * They complement — not replace — the harness's EventEmitter surface: events
 * are fire-and-forget notifications; hooks are interception points.
 *
 * Hook names:
 *   beforeRun        ({ prompt, sessionId, analysis })        — may throw to abort
 *   afterRun         ({ prompt, response, usage, sessionId })
 *   beforeToolCall   ({ toolName, args, sessionId })          — return { deny, reason } to block
 *   afterToolCall    ({ toolName, args, result, durationMs, sessionId })
 *   onToolFailure    ({ toolName, args, error, sessionId })
 *   onPromptSubmit   ({ prompt, sessionId })
 *   onSessionStart   ({ sessionId })
 *   onSessionEnd     ({ sessionId })
 *   onError          ({ error, phase, sessionId })
 *   onBudgetWarning  ({ budget })
 *   onBudgetExceeded ({ budget, estimate })
 */

export const HOOK_NAMES = [
  'beforeRun',
  'afterRun',
  'beforeToolCall',
  'afterToolCall',
  'onToolFailure',
  'onPromptSubmit',
  'onSessionStart',
  'onSessionEnd',
  'onError',
  'onBudgetWarning',
  'onBudgetExceeded',
];

export class HookManager {
  /** @param {Partial<Record<string, Function|Function[]>>} [initial] */
  constructor(initial = {}) {
    this._hooks = new Map(HOOK_NAMES.map((n) => [n, []]));
    for (const [name, fns] of Object.entries(initial)) {
      for (const fn of Array.isArray(fns) ? fns : [fns]) this.register(name, fn);
    }
  }

  /**
   * Register a hook. Returns an unsubscribe function.
   * @param {string} name one of HOOK_NAMES
   * @param {Function} fn
   */
  register(name, fn) {
    if (!this._hooks.has(name)) {
      throw new Error(`Unknown hook "${name}". Valid hooks: ${HOOK_NAMES.join(', ')}`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError(`Hook "${name}" handler must be a function`);
    }
    this._hooks.get(name).push(fn);
    return () => {
      const list = this._hooks.get(name);
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  /** Number of handlers registered for a hook. */
  count(name) {
    return this._hooks.get(name)?.length ?? 0;
  }

  /**
   * Run all handlers for a hook sequentially, passing `payload` to each.
   * Returns an array of handler results. Handler errors propagate (so a
   * beforeRun hook can abort a run by throwing) except for the observe-only
   * hooks, where errors are swallowed into the result list.
   */
  async run(name, payload) {
    const observeOnly = name.startsWith('on') || name.startsWith('after');
    const results = [];
    for (const fn of this._hooks.get(name) ?? []) {
      try {
        results.push(await fn(payload));
      } catch (err) {
        if (observeOnly) results.push({ hookError: err });
        else throw err;
      }
    }
    return results;
  }

  /**
   * Run `beforeToolCall` and collapse the results into a single verdict.
   * The first handler returning `{ deny: true }` wins.
   */
  async toolCallVerdict(payload) {
    const results = await this.run('beforeToolCall', payload);
    for (const r of results) {
      if (r && r.deny) {
        return { deny: true, reason: r.reason ?? 'denied by beforeToolCall hook' };
      }
    }
    return { deny: false };
  }
}
