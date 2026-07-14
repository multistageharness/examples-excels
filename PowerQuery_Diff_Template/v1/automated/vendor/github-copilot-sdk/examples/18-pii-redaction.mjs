// 18 — PII redaction before a prompt leaves the process.
//
// A governance need: strip secrets/PII from a prompt before it is sent. We
// redact in application code BEFORE chat(), then use the `onPromptSubmit` hook as
// a guardrail that verifies nothing sensitive slipped through.
//
// NOTE on the hook: in this harness `onPromptSubmit` is OBSERVE-ONLY — it fires
// with the prompt the runtime is about to send but cannot rewrite it. So the
// actual redaction happens in redact() before chat(); the hook only checks the
// result. (No real credential appears in source — patterns use obviously-fake
// fixtures, per repo policy.)
//
// Run:
//   node examples/18-pii-redaction.mjs [--cli-path ...] [--model <id>] [--token-budget <n>] ["prompt"]
//   node examples/18-pii-redaction.mjs --model gpt-5-mini --effort low "Reset the account for alex@example.com (ACCT-48217)."

import { createHarness } from '../src/index.mjs';
import { parseCommonArgs, baseConfig, runExample, requirePrompt } from './_shared.mjs';

const args = parseCommonArgs();
// No prompt => print usage and exit before starting the runtime (0 tokens).
const rawPrompt = requirePrompt(args, 'node examples/18-pii-redaction.mjs "Reset the account for alex@example.com (ACCT-48217)."');

// Patterns to strip. Both match deliberately-fake fixture shapes.
const REDACTIONS = [
  { name: 'email', source: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', replace: '[redacted-email]' },
  { name: 'account-id', source: '\\bACCT-\\d{4,}\\b', replace: '[redacted-account-id]' },
];

function redact(text) {
  let out = text;
  const hits = [];
  for (const r of REDACTIONS) {
    const re = new RegExp(r.source, 'g');
    if (re.test(out)) hits.push(r.name);
    out = out.replace(new RegExp(r.source, 'g'), r.replace);
  }
  return { out, hits };
}

const harness = await createHarness({
  config: baseConfig(args),
  hooks: {
    // Guardrail: assert no raw pattern survived into the submitted prompt.
    onPromptSubmit: ({ prompt }) => {
      const leaked = REDACTIONS.filter((r) => new RegExp(r.source).test(prompt)).map((r) => r.name);
      if (leaked.length) console.error(`[onPromptSubmit] WARNING raw value present: ${leaked.join(', ')}`);
      else console.error('[onPromptSubmit] verified: no raw PII in the submitted prompt');
    },
  },
});

await runExample(harness, async () => {
  const { out: redacted, hits } = redact(rawPrompt);
  console.log(`original : ${rawPrompt}`);
  console.log(`redacted : ${redacted}`);
  console.log(`stripped : ${hits.length ? hits.join(', ') : '(nothing matched)'}`);

  // Send the REDACTED prompt — the raw one never reaches the model.
  const { content } = await harness.chat(redacted);
  console.log(`\n${content}`);
});
