// 14 — LLM-as-judge: grade a candidate answer against a rubric.
//
// An evaluation harness: given a question, a candidate answer, and a rubric,
// score the candidate and return a schema-validated verdict
// `{ score, rationale, pass }`. structured() validates the verdict and runs the
// repair round-trip if the model first returns malformed JSON — the `attempts`
// count makes that observable.
//
// DEMO-GRADE: needs a live, authenticated Copilot CLI to fully run. The
// no-prompt usage guard below exits before the runtime is ever spawned.
//
// Run:
//   node examples/14-llm-as-judge.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["candidate answer"]
//   node examples/14-llm-as-judge.mjs --model gpt-5-mini --effort low "Paris is the capital of France, and also of Europe."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No candidate => print usage and exit before starting the runtime (0 tokens).
const candidate = requirePrompt(args, 'node examples/14-llm-as-judge.mjs "Paris is the capital of France, and also of Europe."');
const harness = await createHarness({ config: baseConfig(args) });

const QUESTION = 'What is the capital of France?';
const RUBRIC = [
  'Award up to 10 points.',
  '10 = factually correct and concise.',
  'Subtract points for any factual error (e.g. claiming a city is the capital of a continent).',
  'pass = true only when score >= 7.',
].join(' ');

const SCHEMA = {
  type: 'object',
  required: ['score', 'rationale', 'pass'],
  additionalProperties: false,
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 10 },
    rationale: { type: 'string', maxLength: 400 },
    pass: { type: 'boolean' },
  },
};

await runExample(harness, async () => {
  const { value, attempts, usage } = await harness.structured(
    'Grade the candidate answer against the rubric and return the verdict.',
    SCHEMA,
    {
      input: { question: QUESTION, candidate, rubric: RUBRIC },
      inputLabel: 'grading-task',
    },
  );
  console.log(JSON.stringify(value, null, 2));
  console.log(
    `\n[verdict in ${attempts} attempt(s), ${usage.totalTokens} tokens — repair runs when JSON is malformed]`,
  );
});
