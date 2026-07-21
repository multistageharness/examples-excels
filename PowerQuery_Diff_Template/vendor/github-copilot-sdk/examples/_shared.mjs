/**
 * Shared CLI argument parsing for the examples.
 *
 * Every example accepts:
 *   --cli-path <path>      explicit Copilot CLI entry (CLI_PATH); falls back to
 *                          COPILOT_CLI_PATH, then module resolution of @github/copilot
 *   --proxy <url>          optional HTTP(S) proxy, scoped to the CLI child process
 *   --model <id>           model id (default gpt-5-mini)
 *   --effort <level>       reasoning effort: low|medium|high|xhigh (default low)
 *   --token-budget <n>     token ceiling (maxTokens). Overrides any budget the
 *                          example sets; keeps that example's warn/enforcement.
 *   --budget-warn <pct>    warn-at percent for the budget (default 80)
 *   --budget-enforcement   block | warn (default block)
 *
 * Defaults for model / effort / budget live here so every example shares them.
 */

export const DEFAULT_MODEL = 'gpt-5-mini';
export const DEFAULT_REASONING_EFFORT = 'low';
// Standard usage budget applied to every example unless it sets its own budget
// or the user overrides on the CLI. One gpt-5-mini low-effort turn costs ~10k
// tokens (the Copilot CLI's own system prompt dominates the heuristic estimate),
// so 9k trips budget:exceeded on a normal turn — but enforcement 'warn' only
// emits the event and lets the run finish, so examples still resolve.
export const DEFAULT_TOKEN_BUDGET = {
  maxTokens: 9_000,
  warnAtPercent: 80,
  enforcement: 'warn',
};

export function parseCommonArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--cli-path': args.cliPath = argv[++i]; break;
      case '--proxy': args.httpProxy = argv[++i]; break;
      case '--model': args.model = argv[++i]; break;
      case '--effort': args.reasoningEffort = argv[++i]; break;
      case '--token-budget':
      case '--max-tokens': args.maxTokens = Number(argv[++i]); break;
      case '--budget-warn': args.warnAtPercent = Number(argv[++i]); break;
      case '--budget-enforcement': args.enforcement = argv[++i]; break;
      default: args._.push(argv[i]);
    }
  }
  return args;
}

/**
 * Resolve the user's message from positional args.
 *
 * Examples deliberately do NOT fall back to a built-in default prompt: if no
 * message is given we print a usage hint and exit BEFORE creating the harness —
 * so nothing is sent to the model and the CLI runtime is never even spawned
 * (0 tokens). The SDK enforces the same rule at a lower level via
 * EmptyPromptError; this is the friendly CLI-side guard that also avoids the
 * cost of starting the runtime just to reject an empty request.
 *
 * @param {object} args  parsed args from parseCommonArgs()
 * @param {string} usage one-line usage hint, e.g. `node examples/01-chat.mjs "your question"`
 * @returns {string} the non-empty user message
 */
export function requirePrompt(args, usage) {
  const message = args._[0];
  if (typeof message !== 'string' || message.trim() === '') {
    console.error('No message provided — nothing sent to the model (0 tokens spent).');
    console.error(`Usage: ${usage}`);
    process.exit(2);
  }
  return message;
}

/**
 * Resolve the token budget for an example.
 *
 * Precedence: CLI flags (--token-budget / --budget-warn / --budget-enforcement)
 * override the budget the example hard-codes, which overrides the shared
 * standard-usage default. The default always applies, so every example runs
 * with a budget unless something higher-precedence replaces it.
 */
function resolveTokenBudget(args, exampleBudget) {
  const base = { ...DEFAULT_TOKEN_BUDGET, ...exampleBudget };
  return {
    ...base,
    ...(args.maxTokens != null && { maxTokens: args.maxTokens }),
    ...(args.warnAtPercent != null && { warnAtPercent: args.warnAtPercent }),
    ...(args.enforcement != null && { enforcement: args.enforcement }),
  };
}

/** Harness config overrides shared by all examples. */
export function baseConfig(args, extra = {}) {
  const { tokenBudget: exampleBudget, ...restExtra } = extra;
  const tokenBudget = resolveTokenBudget(args, exampleBudget);
  return {
    model: args.model ?? DEFAULT_MODEL,
    reasoningEffort: args.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    ...(args.cliPath && { cliPath: args.cliPath }),
    ...(args.httpProxy && { httpProxy: args.httpProxy }),
    // Keep examples on the bare SDK surface.
    cliArgs: ['--disable-builtin-mcps'],
    ...restExtra,
    ...(tokenBudget && { tokenBudget }),
  };
}

/** try/finally + signal-safe runner so client.stop() always executes. */
export async function runExample(harness, fn) {
  const shutdown = async (code) => {
    try {
      await harness.stop();
    } catch (err) {
      console.error('harness.stop() failed:', err);
    }
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
  try {
    await fn();
  } catch (err) {
    console.error(err);
    await shutdown(1);
  }
  await shutdown(0);
}
