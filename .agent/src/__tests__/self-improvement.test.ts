import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  SELF_IMPROVEMENT_DECISION_MARKER,
  SELF_IMPROVEMENT_PROPOSAL_MARKER,
  buildSelfImprovementContinuationComment,
  buildSelfImprovementIssueBody,
  normalizeSelfImprovementDecisionKind,
  parseSelfImprovementDecision,
  type SelfImprovementDecision,
} from "../self-improvement.js";

const context = {
  repo: "co-evolving/repo",
  runId: "1001",
  runUrl: "https://github.com/co-evolving/repo/actions/runs/1001",
  eventName: "schedule",
};

function newIssueDecision(extra: Partial<SelfImprovementDecision> = {}): SelfImprovementDecision {
  return {
    decision: "new_issue",
    reason: "Fresh proposal is the best next route.",
    issueTitle: "code-quality: Add self-improvement route tests",
    issueBody: "## Proposal\n\nAdd tests.",
    targetNumber: null,
    comment: "",
    ...extra,
  };
}

test("normalizes supported self-improvement decision aliases", () => {
  assert.equal(normalizeSelfImprovementDecisionKind("new-issue"), "new_issue");
  assert.equal(normalizeSelfImprovementDecisionKind("create_issue"), "new_issue");
  assert.equal(normalizeSelfImprovementDecisionKind("continue pull request"), "continue_pr");
  assert.equal(normalizeSelfImprovementDecisionKind("existing_issue"), "continue_issue");
  assert.equal(normalizeSelfImprovementDecisionKind("skip"), null);
});

test("parseSelfImprovementDecision accepts fenced JSON for new issues", () => {
  const decision = parseSelfImprovementDecision([
    "```json",
    JSON.stringify({
      decision: "new_issue",
      reason: "No existing target is better.",
      issue_title: "function-advance: Add the route",
      issue_body: "# function-advance: Add the route\n\n## Proposal\nAdd it.",
    }),
    "```",
  ].join("\n"));

  assert.equal(decision.decision, "new_issue");
  assert.equal(decision.reason, "No existing target is better.");
  assert.equal(decision.issueTitle, "function-advance: Add the route");
  assert.match(decision.issueBody, /## Proposal/);
});

test("parseSelfImprovementDecision rejects markdown without JSON", () => {
  assert.throws(
    () => parseSelfImprovementDecision([
      "Context compacted",
      "# documentation-clarity: Explain self-improvement route",
      "",
      "## Proposal",
      "Document the route.",
    ].join("\n")),
    /must contain a JSON object decision/,
  );
});

test("parseSelfImprovementDecision requires target number for continuations", () => {
  assert.throws(
    () => parseSelfImprovementDecision(JSON.stringify({
      decision: "continue_issue",
      reason: "Continue the stuck issue.",
    })),
    /target_number/,
  );

  const decision = parseSelfImprovementDecision(JSON.stringify({
    decision: "continue_pr",
    target_number: 42,
    reason: "The PR is the active target.",
    comment: "Continue review/fix loop.",
  }));
  assert.equal(decision.decision, "continue_pr");
  assert.equal(decision.targetNumber, 42);
});

test("buildSelfImprovementIssueBody adds markers and title without requiring H1", () => {
  const body = buildSelfImprovementIssueBody(newIssueDecision(), context);
  assert.match(body, /^# code-quality: Add self-improvement route tests/m);
  assert.match(body, new RegExp(SELF_IMPROVEMENT_PROPOSAL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body, new RegExp(SELF_IMPROVEMENT_DECISION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body, /sepo-agent-self-improvement-run:1001/);
  assert.match(body, /Self-improvement decision trace/);
  assert.match(body, /Fresh proposal is the best next route/);
});

test("buildSelfImprovementContinuationComment records selected target and reason", () => {
  const comment = buildSelfImprovementContinuationComment({
    decision: "continue_pr",
    targetNumber: 17,
    reason: "Existing PR has the latest useful work.",
    comment: "Please continue this PR instead of opening another issue.",
    issueTitle: "",
    issueBody: "",
  }, context);

  assert.match(comment, /pull request #17/);
  assert.match(comment, /Existing PR has the latest useful work/);
  assert.match(comment, /Please continue this PR/);
  assert.match(comment, /\n\n- Decision: `continue_pr`/);
  assert.match(comment, /\n\nPlease continue this PR/);
  assert.match(comment, /sepo-agent-self-improvement-decision/);
  assert.match(comment, /sepo-agent-self-improvement-run:1001/);
});
