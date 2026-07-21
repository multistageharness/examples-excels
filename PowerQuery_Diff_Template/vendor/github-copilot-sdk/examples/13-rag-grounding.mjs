// 13 — RAG grounding: retrieved snippets -> structured, cited answer.
//
// A retrieval-augmented-generation pattern: feed an ARRAY of retrieved snippets
// as structured `input`, then ask for a schema-validated answer that cites which
// snippet id(s) it used. Distinct from 04's single-object input — this passes a
// list, and the schema forces the model to ground its answer in the corpus.
//
// DEMO-GRADE: needs a live, authenticated Copilot CLI to fully run. The
// no-prompt usage guard below exits before the runtime is ever spawned.
//
// Run:
//   node examples/13-rag-grounding.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["question"]
//   node examples/13-rag-grounding.mjs --model gpt-5-mini --effort low "How do I rotate the API signing key?"

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No question => print usage and exit before starting the runtime (0 tokens).
const question = requirePrompt(args, 'node examples/13-rag-grounding.mjs "How do I rotate the API signing key?"');
const harness = await createHarness({ config: baseConfig(args) });

// Stand-in for a retriever's top-k results. Each snippet has an id the model can cite.
const SNIPPETS = [
  { id: 'runbook-12', text: 'Rotate the API signing key with `platctl keys rotate --service api`. The old key stays valid for 24h.' },
  { id: 'runbook-07', text: 'Restarting the billing service: `platctl restart billing` (drains connections first).' },
  { id: 'sec-03', text: 'Signing keys are stored in Vault under secret/api/signing; never copy them to disk.' },
];

const SCHEMA = {
  type: 'object',
  required: ['answer', 'citations'],
  additionalProperties: false,
  properties: {
    answer: { type: 'string', maxLength: 500 },
    citations: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', description: 'snippet id, e.g. "runbook-12"' },
    },
  },
};

await runExample(harness, async () => {
  // structured() embeds the schema + the snippet array, validates the reply, and
  // auto-repairs (re-asks with the validation errors) on invalid output.
  const { value, attempts, usage } = await harness.structured(question, SCHEMA, {
    input: SNIPPETS,
    inputLabel: 'retrieved-snippets',
  });
  console.log(JSON.stringify(value, null, 2));
  console.log(
    `\n[${attempts} attempt(s), ${usage.totalTokens} tokens, grounded in ${SNIPPETS.length} snippets]`,
  );
});
