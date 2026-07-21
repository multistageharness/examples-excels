/**
 * llm-sdk-github-copilot — harness around the GitHub Copilot SDK.
 *
 * @example
 * import { createHarness } from 'llm-sdk-github-copilot';
 *
 * const harness = await createHarness({
 *   config: { model: 'gpt-5-mini', reasoningEffort: 'low', tokenBudget: { maxTokens: 200_000 } },
 * });
 * try {
 *   const { content } = await harness.chat('What is 2 + 2?');
 *   console.log(content);
 *   console.log(harness.usageReport());
 * } finally {
 *   await harness.stop();
 * }
 */

export {
  CopilotHarness,
  createHarness,
  formatSSE,
  renderContextPreamble,
  assertUserMessage,
  EmptyPromptError,
} from './harness.mjs';

export {
  loadConfig,
  loadConfigFile,
  defaultConfig,
  mergeConfig,
  configFromEnv,
  validateConfig,
  resolveSystemPrompt,
  ConfigError,
  REASONING_EFFORTS,
} from './config.mjs';

export {
  resolveCliPath,
  findCopilot,
  findClosestModuleDir,
  resolveModuleEntry,
  DEFAULT_CANDIDATES,
} from './cli-path.mjs';

export {
  estimateTokens,
  estimateMessagesTokens,
  analyzeRun,
  TokenBudget,
  TokenBudgetExceededError,
} from './tokens.mjs';

export { UsageTracker } from './usage.mjs';
export { HookManager, HOOK_NAMES } from './hooks.mjs';
export { ContextStore } from './store.mjs';
export {
  Observability,
  telemetryConfigFor,
  loadOtelApi,
} from './observability.mjs';

export {
  validateSchema,
  extractJson,
  renderStructuredInput,
  buildStructuredPrompt,
  buildRepairPrompt,
  parseStructuredResponse,
  StructuredOutputError,
} from './structured.mjs';
