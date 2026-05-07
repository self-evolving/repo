import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  parseSelfApprovalDecision,
  resolveSelfApproval,
} from "../self-approval.js";

test("parseSelfApprovalDecision accepts structured verdict JSON", () => {
  const decision = parseSelfApprovalDecision(JSON.stringify({
    verdict: "REQUEST_CHANGES",
    reason: "The product direction needs a narrower trust boundary.",
    handoff_context: "Keep self-approval internal-only.",
    inspected_head_sha: "abc123",
  }));

  assert.equal(decision?.verdict, "request_changes");
  assert.equal(decision?.reason, "The product direction needs a narrower trust boundary.");
  assert.equal(decision?.handoffContext, "Keep self-approval internal-only.");
  assert.equal(decision?.inspectedHeadSha, "abc123");
});

test("resolveSelfApproval blocks when opt-in flag is disabled", () => {
  const result = resolveSelfApproval({
    allowSelfApprove: false,
    targetKind: "pull_request",
    prState: "OPEN",
    expectedHeadSha: "abc123",
    currentHeadSha: "abc123",
    decision: {
      verdict: "approve",
      reason: "Aligned.",
      handoffContext: "",
      inspectedHeadSha: "abc123",
    },
  });

  assert.equal(result.shouldApprove, false);
  assert.equal(result.conclusion, "blocked");
  assert.match(result.reason, /AGENT_ALLOW_SELF_APPROVE/);
});

test("resolveSelfApproval approves only matching open PR heads", () => {
  const result = resolveSelfApproval({
    allowSelfApprove: true,
    targetKind: "pull_request",
    prState: "OPEN",
    expectedHeadSha: "abc123",
    currentHeadSha: "abc123",
    decision: {
      verdict: "approve",
      reason: "Aligned.",
      handoffContext: "",
      inspectedHeadSha: "abc123",
    },
  });

  assert.equal(result.shouldApprove, true);
  assert.equal(result.shouldOrchestrate, false);
  assert.equal(result.conclusion, "approved");
});

test("resolveSelfApproval rejects stale or mismatched head SHAs", () => {
  const stale = resolveSelfApproval({
    allowSelfApprove: true,
    targetKind: "pull_request",
    prState: "OPEN",
    expectedHeadSha: "abc123",
    currentHeadSha: "def456",
    decision: {
      verdict: "approve",
      reason: "Aligned.",
      handoffContext: "",
      inspectedHeadSha: "abc123",
    },
  });
  assert.equal(stale.shouldApprove, false);
  assert.equal(stale.conclusion, "blocked");
  assert.match(stale.reason, /head changed/);

  const mismatch = resolveSelfApproval({
    allowSelfApprove: true,
    targetKind: "pull_request",
    prState: "OPEN",
    expectedHeadSha: "abc123",
    currentHeadSha: "abc123",
    decision: {
      verdict: "approve",
      reason: "Aligned.",
      handoffContext: "",
      inspectedHeadSha: "def456",
    },
  });
  assert.equal(mismatch.shouldApprove, false);
  assert.equal(mismatch.conclusion, "blocked");
  assert.match(mismatch.reason, /different inspected head/);
});

test("resolveSelfApproval requests orchestration for change requests", () => {
  const result = resolveSelfApproval({
    allowSelfApprove: true,
    targetKind: "pull_request",
    prState: "OPEN",
    expectedHeadSha: "abc123",
    currentHeadSha: "abc123",
    decision: {
      verdict: "request_changes",
      reason: "Needs a narrower design.",
      handoffContext: "Remove the public slash route.",
      inspectedHeadSha: "abc123",
    },
  });

  assert.equal(result.shouldApprove, false);
  assert.equal(result.shouldOrchestrate, true);
  assert.equal(result.conclusion, "request_changes");
  assert.equal(result.handoffContext, "Remove the public slash route.");
});
