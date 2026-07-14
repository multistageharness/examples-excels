/**
 * Mock of the @github/copilot-sdk client/session surface used by the
 * harness. Injected via the harness `deps.clientFactory` seam so unit tests
 * never spawn the Copilot CLI.
 *
 * A "script" drives responses: an array of steps (or a function of the
 * prompt) where each step is
 *   { content, inputTokens?, outputTokens?, events?: SessionEvent[] }
 *
 * Thinking / reasoning ("phased-output") models are simulated with:
 *   - reasoning: string | string[]
 *       Emits `assistant.reasoning` events (and `assistant.reasoning_delta`
 *       chunks when streaming) carrying the model's extended thinking. This
 *       is the model's private chain-of-thought, NOT the user-facing answer.
 *   - reasoningTokens: number   → reported on the `assistant.usage` event.
 *   - reasoningText / phase     → attached to the `assistant.message.data`,
 *       mirroring the real SDK fields for Anthropic thinking models.
 *   - messages: Array<{ content, phase?, reasoningText? }>
 *       Emits MULTIPLE `assistant.message` events in order so a phased model
 *       (thinking-phase message, then response-phase message — or a trailing
 *       reasoning message that lands *after* the answer) can be reproduced.
 *       `sendAndWait` returns the LAST one, exactly like the real SDK.
 */

let eventCounter = 0;

function makeEvent(type, data, extra = {}) {
  eventCounter += 1;
  return {
    id: `evt-${eventCounter}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    type,
    data,
    ...extra,
  };
}

export class MockSession {
  constructor(config, script, { sessionId = 'mock-session-1' } = {}) {
    this.config = config;
    this.script = script;
    this.sessionId = config.sessionId ?? sessionId;
    this.typedHandlers = new Map();
    this.sent = [];
    this.disconnected = false;
  }

  on(typeOrHandler, maybeHandler) {
    const [type, handler] = typeof typeOrHandler === 'string'
      ? [typeOrHandler, maybeHandler]
      : ['*', typeOrHandler];
    if (!this.typedHandlers.has(type)) this.typedHandlers.set(type, []);
    this.typedHandlers.get(type).push(handler);
    return () => {
      const list = this.typedHandlers.get(type);
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  emitEvent(type, data, extra) {
    const event = makeEvent(type, data, extra);
    this.config.onEvent?.(event);
    for (const h of this.typedHandlers.get(type) ?? []) h(event);
    for (const h of this.typedHandlers.get('*') ?? []) h(event);
    return event;
  }

  _nextStep(prompt) {
    if (typeof this.script === 'function') return this.script(prompt);
    if (Array.isArray(this.script)) {
      if (!this.script.length) throw new Error('MockSession script exhausted');
      return this.script.shift();
    }
    return this.script ?? { content: 'ok' };
  }

  _streamChunks(type, text, extraData = {}) {
    const chunkSize = Math.max(1, Math.ceil(text.length / 3));
    for (let i = 0; i < text.length; i += chunkSize) {
      this.emitEvent(type, {
        deltaContent: text.slice(i, i + chunkSize),
        ...extraData,
      }, { ephemeral: true });
    }
  }

  async sendAndWait(opts, _timeout) {
    const prompt = typeof opts === 'string' ? opts : opts.prompt;
    this.sent.push({ prompt, opts });
    const step = this._nextStep(prompt);

    for (const ev of step.events ?? []) {
      this.emitEvent(ev.type, ev.data, ev.extra);
    }

    // Extended thinking: emit reasoning *before* the answer, on its own event
    // channel (assistant.reasoning / assistant.reasoning_delta), never as the
    // assistant message content. This is what a thinking model like Opus does.
    const reasoningBlocks = step.reasoning == null
      ? []
      : Array.isArray(step.reasoning) ? step.reasoning : [step.reasoning];
    reasoningBlocks.forEach((text, i) => {
      const reasoningId = `reasoning-${i + 1}`;
      if (this.config.streaming) {
        this._streamChunks('assistant.reasoning_delta', text, { reasoningId });
      }
      // Real SDK shape: AssistantReasoningData carries the thinking text on
      // `content` (not `text`). Pin that here so the harness must read the
      // field the live Copilot runtime actually emits.
      this.emitEvent('assistant.reasoning', { content: text, reasoningId });
    });

    this.emitEvent('assistant.usage', {
      model: this.config.model ?? 'mock-model',
      inputTokens: step.inputTokens ?? 10,
      outputTokens: step.outputTokens ?? 5,
      reasoningTokens: step.reasoningTokens ?? 0,
      duration: step.duration ?? 42,
      timeToFirstTokenMs: step.ttft ?? 7,
    }, { ephemeral: true });

    // A phased model can emit several assistant.message events (thinking phase,
    // response phase, or a reasoning message trailing *after* the answer). The
    // real sendAndWait keeps the LAST one regardless of phase.
    const messages = step.messages ?? [
      { content: step.content, phase: step.phase, reasoningText: step.reasoningText },
    ];
    let last;
    for (const m of messages) {
      const isThinking = m.phase === 'thinking';
      if (this.config.streaming && m.content) {
        // Thinking-phase text streams on the reasoning channel; only the
        // response phase streams on the user-facing message channel.
        this._streamChunks(
          isThinking ? 'assistant.reasoning_delta' : 'assistant.message_delta',
          m.content,
        );
      }
      const data = { content: m.content ?? '' };
      if (m.phase != null) data.phase = m.phase;
      if (m.reasoningText != null) data.reasoningText = m.reasoningText;
      last = this.emitEvent('assistant.message', data);
    }
    this.emitEvent('session.idle', {});
    return last;
  }

  async disconnect() {
    this.disconnected = true;
  }
}

export class MockClient {
  /**
   * @param {object} options client options captured for assertions
   * @param {object} [behavior] { script, failResume, resumeScripts }
   */
  constructor(options = {}, behavior = {}) {
    this.options = options;
    this.behavior = behavior;
    this.sessions = [];
    this.stopped = false;
    this.lastSessionConfig = null;
  }

  async createSession(config) {
    this.lastSessionConfig = config;
    const session = new MockSession(config, this.behavior.script, {
      sessionId: `mock-session-${this.sessions.length + 1}`,
    });
    this.sessions.push(session);
    return session;
  }

  async resumeSession(sessionId, config) {
    if (this.behavior.failResume) {
      throw new Error(`session not found: ${sessionId}`);
    }
    this.lastSessionConfig = config;
    const session = new MockSession(
      { ...config, sessionId },
      this.behavior.resumeScript ?? this.behavior.script,
    );
    this.sessions.push(session);
    return session;
  }

  async stop() {
    this.stopped = true;
    return [];
  }
}

/**
 * Build harness deps wiring a MockClient. Returns { deps, ref } where
 * ref.client is set once the harness starts.
 */
export function mockDeps(behavior = {}, env = {}) {
  const ref = { client: null };
  const deps = {
    env: { ...env },
    clientFactory: async (options) => {
      ref.client = new MockClient(options, behavior);
      return ref.client;
    },
  };
  return { deps, ref };
}
