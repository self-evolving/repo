import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  determineRunStatus,
  extractJsonObject,
  normalizeImplementationResponse,
  summaryFromAgentResponse,
  formatImplementComment,
  formatFixPrComment,
  formatReviewComment,
  formatRubricsUpdateComment,
} from "../response.js";

// --- determineRunStatus ---

test("determineRunStatus returns failed when agent exit is non-zero", () => {
  assert.equal(determineRunStatus(1, true, 0), "failed");
});

test("determineRunStatus returns no_changes when agent succeeded but no changes", () => {
  assert.equal(determineRunStatus(0, false, 0), "no_changes");
});

test("determineRunStatus returns success for clean branch head updates", () => {
  assert.equal(determineRunStatus(0, false, 0, true), "success");
});

test("determineRunStatus returns verify_failed for changed head when verify fails", () => {
  assert.equal(determineRunStatus(0, false, 1, true), "verify_failed");
});

test("determineRunStatus returns verify_failed when verify fails", () => {
  assert.equal(determineRunStatus(0, true, 1), "verify_failed");
});

test("determineRunStatus returns success when all checks pass", () => {
  assert.equal(determineRunStatus(0, true, 0), "success");
});

// --- extractJsonObject ---

test("extractJsonObject extracts raw JSON", () => {
  const json = extractJsonObject('{"summary":"done","pr_title":"feat: test"}');
  assert.equal(JSON.parse(json).summary, "done");
});

test("extractJsonObject extracts fenced JSON", () => {
  const json = extractJsonObject('```json\n{"summary":"done"}\n```');
  assert.equal(JSON.parse(json).summary, "done");
});

test("extractJsonObject handles nested braces in strings", () => {
  const json = extractJsonObject('{"body":"a { b } c"}');
  assert.equal(JSON.parse(json).body, "a { b } c");
});

test("extractJsonObject returns empty for no JSON", () => {
  assert.equal(extractJsonObject("just plain text"), "");
});

// --- normalizeImplementationResponse ---

test("normalizeImplementationResponse parses valid JSON", () => {
  const result = normalizeImplementationResponse(
    '{"summary":"Added feature","commit_message":"feat: add it","pr_title":"feat: add it","pr_body":"## Changes\\n- done"}'
  );
  assert.equal(result.summary, "Added feature");
  assert.equal(result.commitMessage, "feat: add it");
  assert.equal(result.prTitle, "feat: add it");
  assert.match(result.prBody, /Changes/);
});

test("normalizeImplementationResponse falls back to plain text", () => {
  const result = normalizeImplementationResponse("Just some plain text output");
  assert.equal(result.summary, "Just some plain text output");
  assert.equal(result.commitMessage, "");
  assert.equal(result.prTitle, "");
  assert.equal(result.prBody, "");
});

test("normalizeImplementationResponse handles empty input", () => {
  const result = normalizeImplementationResponse("");
  assert.equal(result.summary, "");
  assert.equal(result.commitMessage, "");
});

test("normalizeImplementationResponse normalizes commit message whitespace", () => {
  const result = normalizeImplementationResponse(
    '{"summary":"Added feature","commit_message":"feat:   add\\nfeature"}'
  );
  assert.equal(result.commitMessage, "feat: add feature");
});

test("summaryFromAgentResponse parses fix-pr JSON summaries", () => {
  const summary = summaryFromAgentResponse(
    "fix-pr",
    '{"summary":"- Fixed the failing parser\\n- Added coverage","commit_message":"fix: repair parser"}'
  );
  assert.equal(summary, "- Fixed the failing parser\n- Added coverage");
});

test("summaryFromAgentResponse leaves review text unchanged", () => {
  const summary = summaryFromAgentResponse("review", "## Summary\nLooks good.");
  assert.equal(summary, "## Summary\nLooks good.");
});

// --- formatImplementComment ---

test("formatImplementComment formats success with PR link", () => {
  const body = formatImplementComment({
    status: "success",
    summary: "Added the feature.",
    branch: "agent/codex-42",
    prUrl: "https://github.com/org/repo/pull/43",
  });
  assert.match(body, /implementation finished/);
  assert.match(body, /agent\/codex-42/);
  assert.match(body, /pull\/43/);
});

test("formatImplementComment formats no_changes", () => {
  const body = formatImplementComment({ status: "no_changes" });
  assert.match(body, /did not produce code changes/);
});

// --- formatFixPrComment ---

test("formatFixPrComment formats success", () => {
  const body = formatFixPrComment({
    status: "success",
    branch: "feat/my-branch",
    requestedBy: "alice",
  });
  assert.match(body, /pushed fixes/);
  assert.match(body, /@alice/);
});

test("formatFixPrComment formats unsupported", () => {
  const body = formatFixPrComment({ status: "unsupported" });
  assert.match(body, /could not update this PR/);
});

// --- formatReviewComment ---

test("formatReviewComment builds synthesis header", () => {
  const body = formatReviewComment({
    synthesisBody: "## Summary\nLooks good.",
    requestedBy: "bob",
  });
  assert.match(body, /AI Review Synthesis/);
  assert.match(body, /<!-- sepo-agent-review-synthesis -->/);
  assert.match(body, /@bob/);
  assert.match(body, /Looks good/);
});

// --- formatRubricsUpdateComment ---

test("formatRubricsUpdateComment reports committed updates with summary", () => {
  const body = formatRubricsUpdateComment({
    prNumber: 286,
    rubricsRef: "agent/rubrics",
    rubricsCommitted: true,
    runSucceeded: true,
    summary: "Added docs sync rubric.",
  });
  assert.match(body, /Rubrics Update/);
  assert.match(body, /Updated `agent\/rubrics` from PR #286/);
  assert.match(body, /Added docs sync rubric/);
});

test("formatRubricsUpdateComment reports no changes", () => {
  const body = formatRubricsUpdateComment({
    prNumber: "286",
    rubricsRef: "agent/rubrics",
    rubricsCommitted: false,
    runSucceeded: true,
    summary: "no rubric changes",
  });
  assert.match(body, /No changes were committed to `agent\/rubrics` from PR #286/);
  assert.match(body, /no rubric changes/);
});

test("formatRubricsUpdateComment reports failed runs", () => {
  const body = formatRubricsUpdateComment({
    prNumber: "286",
    rubricsRef: "agent/rubrics",
    rubricsCommitted: false,
    runSucceeded: false,
  });
  assert.match(body, /did not complete successfully/);
});
