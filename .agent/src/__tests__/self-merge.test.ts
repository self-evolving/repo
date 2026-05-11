import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  evaluateSelfMergeApproval,
  formatSelfMergeBody,
  resolveSelfMerge,
  summarizeStatusChecks,
} from "../self-merge.js";

const approval = {
  approved: true,
  approvedHeadSha: "abc123",
  reason: "found current-head self-approval from the authenticated Sepo actor",
};

const baseInput = {
  allowSelfMerge: true,
  targetKind: "pull_request",
  prState: "OPEN",
  isDraft: false,
  currentHeadSha: "abc123",
  reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN",
  mergeable: "MERGEABLE",
  statusChecks: [],
  approval,
};

test("evaluateSelfMergeApproval requires a current-head self-approval review", () => {
  const current = evaluateSelfMergeApproval({
    trustedActorLogin: "sepo-agent-app[bot]",
    currentHeadSha: "abc123",
    reviews: [
      {
        id: "1",
        authorLogin: "app/sepo-agent-app",
        state: "APPROVED",
        commitId: "abc123",
        submittedAt: "2026-05-10T10:00:00Z",
        body: "Sepo self-approval completed.\n\n<!-- sepo-agent-self-approval -->",
      },
    ],
  });
  assert.equal(current.approved, true);

  const stale = evaluateSelfMergeApproval({
    trustedActorLogin: "sepo-agent-app",
    currentHeadSha: "def456",
    reviews: [
      {
        id: "1",
        authorLogin: "sepo-agent-app[bot]",
        state: "APPROVED",
        commitId: "abc123",
        submittedAt: "2026-05-10T10:00:00Z",
        body: "Sepo self-approval completed.\n\n<!-- sepo-agent-self-approval -->",
      },
    ],
  });
  assert.equal(stale.approved, false);
  assert.match(stale.reason, /different head SHA/);

  const untrusted = evaluateSelfMergeApproval({
    trustedActorLogin: "sepo-agent-app",
    currentHeadSha: "abc123",
    reviews: [
      {
        id: "1",
        authorLogin: "someone-else",
        state: "APPROVED",
        commitId: "abc123",
        submittedAt: "2026-05-10T10:00:00Z",
        body: "Sepo self-approval completed.\n\n<!-- sepo-agent-self-approval -->",
      },
    ],
  });
  assert.equal(untrusted.approved, false);
  assert.match(untrusted.reason, /missing current-head self-approval/);
});

test("summarizeStatusChecks separates pending and failing checks", () => {
  const summary = summarizeStatusChecks([
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS", state: "" },
    { name: "test", status: "IN_PROGRESS", conclusion: "", state: "" },
    { name: "lint", status: "COMPLETED", conclusion: "FAILURE", state: "" },
  ]);

  assert.equal(summary.total, 3);
  assert.deepEqual(summary.pendingNames, ["test"]);
  assert.deepEqual(summary.failedNames, ["lint"]);
});

test("resolveSelfMerge blocks disabled, stale, requested-changes, and failed-check states", () => {
  assert.match(resolveSelfMerge({ ...baseInput, allowSelfMerge: false }).reason, /AGENT_ALLOW_SELF_MERGE/);
  assert.match(
    resolveSelfMerge({
      ...baseInput,
      approval: { approved: false, approvedHeadSha: "old", reason: "latest self-approval reviewed a different head SHA" },
    }).reason,
    /different head SHA/,
  );
  assert.match(resolveSelfMerge({ ...baseInput, reviewDecision: "CHANGES_REQUESTED" }).reason, /requested changes/);
  assert.match(
    resolveSelfMerge({
      ...baseInput,
      statusChecks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", state: "" }],
    }).reason,
    /status checks are failing: test/,
  );
});

test("resolveSelfMerge marks draft PRs ready before merging", () => {
  const result = resolveSelfMerge({
    ...baseInput,
    isDraft: true,
  });

  assert.equal(result.conclusion, "merged");
  assert.equal(result.nextStep, "merge");
  assert.equal(result.markReady, true);
});

test("resolveSelfMerge marks draft PRs ready before mergeability recheck", () => {
  const result = resolveSelfMerge({
    ...baseInput,
    isDraft: true,
    mergeStateStatus: "DRAFT",
    mergeable: "UNKNOWN",
  });

  assert.equal(result.conclusion, "blocked");
  assert.equal(result.nextStep, "none");
  assert.equal(result.markReady, true);
  assert.match(result.reason, /not currently mergeable/);
});

test("resolveSelfMerge merges into the configured PR base", () => {
  const result = resolveSelfMerge(baseInput);

  assert.equal(result.conclusion, "merged");
  assert.equal(result.nextStep, "merge");
});

test("resolveSelfMerge chooses immediate merge only when GitHub reports mergeable", () => {
  const result = resolveSelfMerge(baseInput);

  assert.equal(result.conclusion, "merged");
  assert.equal(result.nextStep, "merge");

  const blocked = resolveSelfMerge({
    ...baseInput,
    mergeStateStatus: "BLOCKED",
    mergeable: "UNKNOWN",
  });
  assert.equal(blocked.conclusion, "blocked");
  assert.match(blocked.reason, /not currently mergeable/);
});

test("resolveSelfMerge enables auto-merge while checks are pending", () => {
  const result = resolveSelfMerge({
    ...baseInput,
    mergeStateStatus: "BLOCKED",
    mergeable: "UNKNOWN",
    statusChecks: [{ name: "check", status: "IN_PROGRESS", conclusion: "", state: "" }],
  });

  assert.equal(result.conclusion, "auto_merge_enabled");
  assert.equal(result.nextStep, "enable_auto_merge");
  assert.match(result.reason, /enabling GitHub auto-merge/);

  const alreadyEnabled = resolveSelfMerge({
    ...baseInput,
    autoMergeRequestExists: true,
    mergeStateStatus: "BLOCKED",
    mergeable: "UNKNOWN",
    statusChecks: [{ name: "check", status: "IN_PROGRESS", conclusion: "", state: "" }],
  });
  assert.equal(alreadyEnabled.conclusion, "auto_merge_enabled");
  assert.equal(alreadyEnabled.nextStep, "none");
});

test("formatSelfMergeBody includes visible status and marker", () => {
  const body = formatSelfMergeBody({
    conclusion: "blocked",
    reason: "pull request is not currently mergeable",
    runUrl: "https://github.com/self-evolving/repo/actions/runs/123",
  });

  assert.match(body, /\| Blocked \| `blocked` \|/);
  assert.match(body, /not currently mergeable/);
  assert.match(body, /<!-- sepo-agent-self-merge -->/);
});
