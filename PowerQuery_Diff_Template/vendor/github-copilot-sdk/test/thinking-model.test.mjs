/**
 * Thinking / reasoning ("phased-output") model behavior.
 *
 * Models like Claude Opus emit their extended thinking on a separate channel
 * (`assistant.reasoning` / `assistant.reasoning_delta`) and/or as phased
 * `assistant.message` events tagged `phase: "thinking"` vs `"response"`. The
 * harness must return the user-facing ANSWER — never the model's private
 * chain-of-thought — and surface the reasoning separately.
 *
 * These tests pin that contract against the realistic event shapes the
 * GitHub Copilot SDK produces for thinking models.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CopilotHarness } from "../src/harness.mjs";
import { mockDeps } from "./helpers/mock-sdk.mjs";

const THINKING =
  "The user asks for 2+2. I should add the two integers: 2 plus 2 equals 4.";
const ANSWER = "2 + 2 = 4.";

function opusHarness(behavior) {
  const { deps, ref } = mockDeps(behavior);
  const harness = new CopilotHarness(
    { config: { model: "claude-opus-4-8", reasoningEffort: "high" } },
    deps,
  );
  return { harness, ref };
}

test("thinking model: chat returns the answer, not the reasoning", async () => {
  // Reasoning arrives on its own channel before a single answer message.
  const { harness } = opusHarness({
    script: [
      { reasoning: THINKING, reasoningTokens: 64, content: ANSWER },
    ],
  });

  const { content } = await harness.chat("What is 2+2?");

  assert.equal(content, ANSWER);
  assert.ok(
    !content.includes("I should add"),
    `answer leaked the chain-of-thought: ${content}`,
  );
  await harness.stop();
});

test("thinking model: reasoning is surfaced separately on the result", async () => {
  const { harness } = opusHarness({
    script: [{ reasoning: THINKING, reasoningTokens: 64, content: ANSWER }],
  });

  const result = await harness.chat("What is 2+2?");

  assert.equal(result.content, ANSWER);
  assert.ok(
    result.reasoning?.includes("equals 4"),
    "reasoning text should be exposed on the result",
  );
  await harness.stop();
});

test("thinking model: thinking object exposes ordered reasoning steps", async () => {
  // The result carries a structured `thinking` object: joined text + the
  // ordered reasoning blocks. Pins the field the live Copilot SDK emits
  // (assistant.reasoning -> data.content), which a non-thinking turn omits.
  const { harness } = opusHarness({
    script: [
      {
        reasoning: ["First, parse the request.", "Then compute 2 + 2 = 4."],
        content: ANSWER,
      },
    ],
  });

  const { thinking } = await harness.chat("What is 2+2?");

  assert.ok(thinking, "thinking object should be present for a thinking turn");
  assert.deepEqual(thinking.steps, [
    "First, parse the request.",
    "Then compute 2 + 2 = 4.",
  ]);
  assert.ok(thinking.text.includes("2 + 2 = 4"));
  await harness.stop();
});

test("non-thinking turn: thinking is null", async () => {
  const { harness } = opusHarness({ script: [{ content: ANSWER }] });

  const { thinking, reasoning } = await harness.chat("What is 2+2?");

  assert.equal(thinking, null);
  assert.equal(reasoning, null);
  await harness.stop();
});

test("thinking model: reasoning tokens are tracked in the usage summary", async () => {
  const { harness } = opusHarness({
    script: [
      { reasoning: THINKING, reasoningTokens: 64, content: ANSWER, outputTokens: 8 },
    ],
  });

  await harness.chat("What is 2+2?");
  const summary = harness.usageSummary();

  assert.equal(summary.tokens.reasoning, 64);
  await harness.stop();
});

test("thinking model: phased messages (thinking phase then response phase)", async () => {
  // The model emits the thinking as an assistant.message (phase=thinking)
  // followed by the real answer (phase=response).
  const { harness } = opusHarness({
    script: [
      {
        messages: [
          { content: THINKING, phase: "thinking" },
          { content: ANSWER, phase: "response" },
        ],
      },
    ],
  });

  const { content } = await harness.chat("What is 2+2?");

  assert.equal(content, ANSWER);
  await harness.stop();
});

test("thinking model: trailing reasoning message after the answer is ignored", async () => {
  // Regression for the reported bug: the SDK's sendAndWait returns the LAST
  // assistant.message, and the Copilot changelog notes reasoning emitted after
  // tool calls "appears at the bottom of the timeline" — i.e. a thinking-phase
  // message can land AFTER the answer. The harness must still return the answer.
  const { harness } = opusHarness({
    script: [
      {
        messages: [
          { content: ANSWER, phase: "response" },
          { content: THINKING, phase: "thinking" },
        ],
      },
    ],
  });

  const { content } = await harness.chat("What is 2+2?");

  assert.equal(
    content,
    ANSWER,
    "harness returned the trailing thinking message instead of the answer",
  );
  await harness.stop();
});

test("thinking model: streaming yields the answer deltas, not reasoning deltas", async () => {
  const { harness } = opusHarness({
    script: [
      { reasoning: THINKING, reasoningTokens: 32, content: ANSWER },
    ],
  });

  const deltas = [];
  let finalContent = "";
  for await (const item of harness.stream("What is 2+2?")) {
    if (item.type === "delta") deltas.push(item.content);
    else if (item.type === "message") finalContent = item.content;
  }

  const streamed = deltas.join("");
  assert.equal(streamed, ANSWER, "streamed deltas should be the answer only");
  assert.ok(
    !streamed.includes("I should add"),
    `reasoning leaked into the answer stream: ${streamed}`,
  );
  assert.equal(finalContent, ANSWER);
  await harness.stop();
});

test("thinking model: an empty answer phase does not fall back to thinking text", async () => {
  // Defensive: if the response-phase message is empty, the harness must not
  // substitute the thinking text — it returns empty rather than the reasoning.
  const { harness } = opusHarness({
    script: [
      {
        messages: [
          { content: THINKING, phase: "thinking" },
          { content: "", phase: "response" },
        ],
      },
    ],
  });

  const { content } = await harness.chat("What is 2+2?");

  assert.notEqual(content, THINKING);
  await harness.stop();
});
