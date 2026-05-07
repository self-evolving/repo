import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  evaluateSelfApprovalProvenance,
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

test("resolveSelfApproval rejects approval verdicts without inspected head SHA", () => {
  for (const inspectedHeadSha of ["", "   "]) {
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
        inspectedHeadSha,
      },
    });

    assert.equal(result.shouldApprove, false);
    assert.equal(result.conclusion, "blocked");
    assert.match(result.reason, /missing inspected head SHA/);
  }
});

test("resolveSelfApproval blocks approval without trusted review provenance", () => {
  const result = resolveSelfApproval({
    allowSelfApprove: true,
    targetKind: "pull_request",
    prState: "OPEN",
    expectedHeadSha: "abc123",
    currentHeadSha: "abc123",
    approvalProvenanceTrusted: false,
    approvalProvenanceReason: "latest trusted review synthesis verdict is needs_rework, not SHIP",
    decision: {
      verdict: "approve",
      reason: "Aligned.",
      handoffContext: "",
      inspectedHeadSha: "abc123",
    },
  });

  assert.equal(result.shouldApprove, false);
  assert.equal(result.shouldOrchestrate, false);
  assert.equal(result.conclusion, "blocked");
  assert.match(result.reason, /needs_rework/);
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

test("evaluateSelfApprovalProvenance requires the latest trusted ship signal", () => {
  const trusted = evaluateSelfApprovalProvenance({
    trustedActorLogin: "sepo-agent-app[bot]",
    expectedHeadSha: "abc123",
    comments: [
      {
        authorLogin: "app/sepo-agent-app",
        createdAt: "2026-05-07T10:00:00Z",
        body: "## AI Review Synthesis\n\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: abc123 -->\n\n## Final Verdict\n\nSHIP",
      },
    ],
  });
  assert.equal(trusted.trusted, true);
  assert.match(trusted.reason, /SHIP/);

  const superseded = evaluateSelfApprovalProvenance({
    trustedActorLogin: "sepo-agent-app[bot]",
    expectedHeadSha: "abc123",
    comments: [
      {
        authorLogin: "sepo-agent-app",
        createdAt: "2026-05-07T10:00:00Z",
        body: "## AI Review Synthesis\n\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: abc123 -->\n\n## Final Verdict\n\nSHIP",
      },
      {
        authorLogin: "sepo-agent-app",
        createdAt: "2026-05-07T10:05:00Z",
        body: "## AI Review Synthesis\n\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: abc123 -->\n\n## Final Verdict\n\nNEEDS_REWORK",
      },
    ],
  });
  assert.equal(superseded.trusted, false);
  assert.match(superseded.reason, /needs_rework/);

  const untrusted = evaluateSelfApprovalProvenance({
    trustedActorLogin: "sepo-agent-app[bot]",
    expectedHeadSha: "abc123",
    comments: [
      {
        authorLogin: "someone-else",
        createdAt: "2026-05-07T10:00:00Z",
        body: "## AI Review Synthesis\n\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: abc123 -->\n\n## Final Verdict\n\nSHIP",
      },
    ],
  });
  assert.equal(untrusted.trusted, false);
  assert.match(untrusted.reason, /missing trusted/);
});

test("evaluateSelfApprovalProvenance requires review synthesis for the current head", () => {
  const stale = evaluateSelfApprovalProvenance({
    trustedActorLogin: "sepo-agent-app[bot]",
    expectedHeadSha: "def456",
    comments: [
      {
        authorLogin: "sepo-agent-app",
        createdAt: "2026-05-07T10:00:00Z",
        body: "## AI Review Synthesis\n\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: abc123 -->\n\n## Final Verdict\n\nSHIP",
      },
    ],
  });
  assert.equal(stale.trusted, false);
  assert.match(stale.reason, /different head SHA/);

  const missingHead = evaluateSelfApprovalProvenance({
    trustedActorLogin: "sepo-agent-app[bot]",
    expectedHeadSha: "abc123",
    comments: [
      {
        authorLogin: "sepo-agent-app",
        createdAt: "2026-05-07T10:00:00Z",
        body: "## AI Review Synthesis\n\n<!-- sepo-agent-review-synthesis -->\n\n## Final Verdict\n\nSHIP",
      },
    ],
  });
  assert.equal(missingHead.trusted, false);
  assert.match(missingHead.reason, /missing reviewed head SHA/);

  const rubricsOnly = evaluateSelfApprovalProvenance({
    trustedActorLogin: "sepo-agent-app[bot]",
    expectedHeadSha: "abc123",
    comments: [
      {
        authorLogin: "sepo-agent-app",
        createdAt: "2026-05-07T10:00:00Z",
        body: "## Rubrics Review\n\n## Final Rubric Verdict\n\nPASS",
      },
    ],
  });
  assert.equal(rubricsOnly.trusted, false);
  assert.match(rubricsOnly.reason, /missing trusted review synthesis/);
});
