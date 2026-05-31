import { test } from "node:test";
import { strict as assert } from "node:assert";

import { selectPromptForSessionOutcome } from "../acpx-adapter.js";
import {
  buildContinuationPrompt,
  selectContinuationPromptForResume,
  shouldReplayFullPromptOnResume,
} from "../prompt-continuation.js";
import { buildAnswerReviewContext } from "../answer-review-context.js";

test("continuation prompt preserves latest trigger metadata and request text", () => {
  const prompt = buildContinuationPrompt({
    REQUEST_SOURCE_KIND: "pull_request_review",
    REQUEST_COMMENT_ID: "12345",
    REQUEST_COMMENT_URL: "https://github.com/self-evolving/repo/pull/77#pullrequestreview-12345",
    REQUEST_TEXT: "@sepo-agent /fix-pr",
  });

  assert.match(prompt, /Triggering source kind: `pull_request_review`/);
  assert.match(prompt, /Triggering comment\/review ID: `12345`/);
  assert.match(prompt, /@sepo-agent \/fix-pr/);
});

test("continuation prompt preserves review-triggered answer context", () => {
  const reviewContext = buildAnswerReviewContext({
    repoSlug: "self-evolving/repo",
    targetNumber: "77",
    sourceKind: "pull_request_review",
    commentId: "12345",
    commentUrl: "https://github.com/self-evolving/repo/pull/77#pullrequestreview-12345",
  });
  const prompt = buildContinuationPrompt({
    ANSWER_REVIEW_CONTEXT: reviewContext,
    REQUEST_SOURCE_KIND: "pull_request_review",
    REQUEST_COMMENT_ID: "12345",
    REQUEST_COMMENT_URL: "https://github.com/self-evolving/repo/pull/77#pullrequestreview-12345",
    REQUEST_TEXT: "@sepo-agent /answer please respond inline",
  });

  assert.match(prompt, /Triggering source kind: `pull_request_review`/);
  assert.match(prompt, /Review-triggered answer context/);
  assert.match(prompt, /Request review ID: `12345`/);
  assert.match(prompt, /gh api repos\/self-evolving\/repo\/pulls\/77\/reviews\/12345\/comments/);
  assert.match(prompt, /targeted inline replies/);
  assert.match(prompt, /@sepo-agent \/answer please respond inline/);
});

test("resumed orchestrated fix-pr replays the full route prompt", () => {
  const promptVars = {
    REQUEST_SOURCE_KIND: "workflow_dispatch",
    REQUEST_TEXT: "@sepo-agent /orchestrate",
    ORCHESTRATOR_CONTEXT:
      "Address review synthesis: validate marker source, correct docs, classify terminal states.",
  };
  const continuationPrompt = buildContinuationPrompt(promptVars);
  const selectedContinuationPrompt = selectContinuationPromptForResume({
    route: "fix-pr",
    promptVars,
    continuationPrompt,
  });

  assert.equal(shouldReplayFullPromptOnResume("fix-pr", promptVars), true);
  assert.equal(selectedContinuationPrompt, undefined);

  const agentFacingPrompt = selectPromptForSessionOutcome({
    fullPrompt:
      "Full fix-pr prompt\nOrchestrator handoff context:\n" +
      promptVars.ORCHESTRATOR_CONTEXT,
    continuationPrompt: selectedContinuationPrompt,
    outcome: { kind: "resumed", resumedFromSessionId: "ses-pr-77" },
  });

  assert.match(agentFacingPrompt, /validate marker source/);
  assert.match(agentFacingPrompt, /classify terminal states/);
  assert.notEqual(agentFacingPrompt, continuationPrompt);
});

test("direct fix-pr resumes still use the lightweight continuation prompt", () => {
  const promptVars = {
    REQUEST_SOURCE_KIND: "issue_comment",
    REQUEST_TEXT: "@sepo-agent /fix-pr please address the latest comment",
    ORCHESTRATOR_CONTEXT: "",
  };
  const continuationPrompt = buildContinuationPrompt(promptVars);

  assert.equal(shouldReplayFullPromptOnResume("fix-pr", promptVars), false);
  assert.equal(
    selectContinuationPromptForResume({ route: "fix-pr", promptVars, continuationPrompt }),
    continuationPrompt,
  );
});

test("non-fix-pr routes keep continuation prompts even with supplemental context", () => {
  const promptVars = {
    REQUEST_TEXT: "@sepo-agent /review",
    ORCHESTRATOR_CONTEXT: "Review the fix after the automated branch update.",
  };
  const continuationPrompt = buildContinuationPrompt(promptVars);

  assert.equal(shouldReplayFullPromptOnResume("review", promptVars), false);
  assert.equal(
    selectContinuationPromptForResume({ route: "review", promptVars, continuationPrompt }),
    continuationPrompt,
  );
});
