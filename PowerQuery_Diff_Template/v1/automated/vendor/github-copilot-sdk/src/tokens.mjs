/**
 * Token estimation, budget enforcement, and pre-run usage analysis.
 *
 * Estimation is heuristic (no tokenizer dependency): ~4 characters per token
 * for prose, with a word-count floor so dense code/whitespace doesn't
 * under-count. Real usage is reconciled from the SDK's `assistant.usage`
 * events after each run, so the budget tracks actuals — the estimate is only
 * used for the preflight gate.
 */

const CHARS_PER_TOKEN = 4;

/** Heuristic token estimate for a string. */
export function estimateTokens(text) {
  if (text == null) return 0;
  const s = String(text);
  if (s.length === 0) return 0;
  const byChars = Math.ceil(s.length / CHARS_PER_TOKEN);
  const byWords = Math.ceil(s.split(/\s+/).filter(Boolean).length * 4 / 3);
  return Math.max(byChars, byWords);
}

/** Estimate tokens for an array of {role, content} messages. */
export function estimateMessagesTokens(messages = []) {
  // ~4 tokens of per-message framing overhead, mirroring chat-format costs.
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m?.content) + 4,
    0,
  );
}

export class TokenBudgetExceededError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TokenBudgetExceededError';
    Object.assign(this, details);
  }
}

/**
 * Tracks cumulative token spend against a configurable ceiling.
 * `maxTokens: null` means unlimited (tracking only).
 */
export class TokenBudget {
  /**
   * @param {object} [opts]
   * @param {number|null} [opts.maxTokens]
   * @param {number} [opts.warnAtPercent]
   * @param {'block'|'warn'} [opts.enforcement]
   */
  constructor(opts = {}) {
    this.maxTokens = opts.maxTokens ?? null;
    this.warnAtPercent = opts.warnAtPercent ?? 80;
    this.enforcement = opts.enforcement ?? 'block';
    this.used = 0;
    this._warned = false;
  }

  get remaining() {
    return this.maxTokens == null ? Infinity : Math.max(0, this.maxTokens - this.used);
  }

  get utilizationPercent() {
    if (this.maxTokens == null || this.maxTokens === 0) return 0;
    return Math.min(100, (this.used / this.maxTokens) * 100);
  }

  /** Record actual spend. Returns 'ok' | 'warn' | 'exceeded' state transitions. */
  record(tokens) {
    this.used += Math.max(0, tokens || 0);
    if (this.maxTokens == null) return 'ok';
    if (this.used >= this.maxTokens) return 'exceeded';
    if (!this._warned && this.utilizationPercent >= this.warnAtPercent) {
      this._warned = true;
      return 'warn';
    }
    return 'ok';
  }

  /** Would running a request estimated at `estimate` tokens bust the budget? */
  wouldExceed(estimate) {
    if (this.maxTokens == null) return false;
    return this.used + estimate > this.maxTokens;
  }

  /**
   * Preflight gate. Throws TokenBudgetExceededError in 'block' mode when the
   * estimate does not fit; returns the verdict either way.
   */
  checkOrThrow(estimate, context = {}) {
    const exceeded = this.wouldExceed(estimate);
    if (exceeded && this.enforcement === 'block') {
      throw new TokenBudgetExceededError(
        `Token budget exceeded: ${this.used} used + ~${estimate} estimated > ${this.maxTokens} max`,
        { used: this.used, estimate, maxTokens: this.maxTokens, ...context },
      );
    }
    return exceeded;
  }

  snapshot() {
    return {
      maxTokens: this.maxTokens,
      used: this.used,
      remaining: this.maxTokens == null ? null : this.remaining,
      utilizationPercent: Number(this.utilizationPercent.toFixed(1)),
      enforcement: this.enforcement,
    };
  }
}

/**
 * Pre-run token usage analysis: estimate the cost of a prospective request
 * against the current budget before any tokens are spent.
 *
 * @param {object} input
 * @param {string} input.prompt
 * @param {string|null} [input.systemPrompt]
 * @param {Array<{role:string,content:string}>} [input.context] prior turns being attached
 * @param {string[]} [input.attachments] file contents being embedded
 * @param {number} [input.expectedOutputTokens] caller's output-size expectation
 * @param {TokenBudget} [budget]
 */
export function analyzeRun(input, budget) {
  const promptTokens = estimateTokens(input.prompt);
  const systemTokens = estimateTokens(input.systemPrompt);
  const contextTokens = estimateMessagesTokens(input.context);
  const attachmentTokens = (input.attachments ?? [])
    .reduce((sum, a) => sum + estimateTokens(a), 0);
  const expectedOutputTokens = input.expectedOutputTokens ?? 0;

  const estimatedInputTokens =
    promptTokens + systemTokens + contextTokens + attachmentTokens;
  const estimatedTotalTokens = estimatedInputTokens + expectedOutputTokens;

  const report = {
    breakdown: {
      promptTokens,
      systemTokens,
      contextTokens,
      attachmentTokens,
      expectedOutputTokens,
    },
    estimatedInputTokens,
    estimatedTotalTokens,
    budget: budget ? budget.snapshot() : null,
    fitsWithinBudget: budget ? !budget.wouldExceed(estimatedTotalTokens) : true,
  };
  report.recommendation = report.fitsWithinBudget
    ? 'ok'
    : (budget?.enforcement === 'block'
      ? 'blocked: raise tokenBudget.maxTokens, trim the prompt/context, or start a new harness'
      : 'over budget: run will proceed (enforcement=warn) but budget:exceeded will fire');
  return report;
}
