import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildHandoffDedupeKey,
  buildHandoffMarker,
  decideHandoff,
  extractReviewConclusion,
  getHandoffMarkerState,
  hasHandoffMarker,
  isPendingHandoffMarkerStale,
  parseHandoffMarker,
  parsePlannerDecision,
  automationModeAllowsHandoff,
  normalizeAutomationMode,
} from "../handoff.js";

test("handoff skips when automation mode is disabled", () => {
  const decision = decideHandoff({
    automationMode: "disabled",
    sourceAction: "implement",
    sourceConclusion: "success",
    targetNumber: "42",
    nextTargetNumber: "99",
    currentRound: 1,
    maxRounds: 5,
  });

  assert.equal(decision.decision, "skip");
  assert.equal(decision.nextAction, undefined);
});

test("agent mode validates planner handoff against policy", () => {
  const decision = decideHandoff({
    automationMode: "agent",
    sourceAction: "implement",
    sourceConclusion: "success",
    targetNumber: "42",
    nextTargetNumber: "99",
    currentRound: 1,
    maxRounds: 5,
    plannerDecision: {
      decision: "handoff",
      nextAction: "review",
      reason: "Implementation produced a PR.",
      handoffContext: "Review the new PR with special attention to generated workflow permissions.",
    },
  });

  assert.equal(decision.decision, "dispatch");
  assert.equal(decision.nextAction, "review");
  assert.equal(decision.targetNumber, "99");
  assert.match(decision.reason, /agent planner selected review/);
  assert.equal(
    decision.handoffContext,
    "Review the new PR with special attention to generated workflow permissions.",
  );
});

test("agent mode supports issue-level child issue delegation", () => {
  const decision = decideHandoff({
    automationMode: "agent",
    sourceAction: "orchestrate",
    sourceConclusion: "requested",
    targetKind: "issue",
    targetNumber: "76",
    currentRound: 1,
    maxRounds: 5,
    plannerDecision: {
      decision: "delegate_issue",
      reason: "Split the work into a child task.",
      childStage: "stage 1",
      childInstructions: "Implement the first stage.",
      basePr: "66",
    },
  });

  assert.equal(decision.decision, "delegate_issue");
  assert.equal(decision.nextAction, undefined);
  assert.equal(decision.targetNumber, "76");
  assert.equal(decision.childStage, "stage 1");
  assert.equal(decision.childInstructions, "Implement the first stage.");
  assert.equal(decision.basePr, "66");
});

test("agent mode supports issue-level orchestrate handoff to implement", () => {
  const decision = decideHandoff({
    automationMode: "agent",
    sourceAction: "orchestrate",
    sourceConclusion: "requested",
    targetKind: "issue",
    targetNumber: "76",
    currentRound: 1,
    maxRounds: 5,
    plannerDecision: {
      decision: "handoff",
      nextAction: "implement",
      reason: "The current issue is small and self-contained.",
      baseBranch: "feature-base",
    },
  });

  assert.equal(decision.decision, "dispatch");
  assert.equal(decision.nextAction, "implement");
  assert.equal(decision.targetNumber, "76");
  assert.equal(decision.nextRound, 2);
  assert.match(decision.reason, /agent planner selected implement/);
  assert.equal(decision.baseBranch, "feature-base");
});

test("agent mode rejects invalid child issue delegation", () => {
  const wrongTarget = decideHandoff({
    automationMode: "agent",
    sourceAction: "orchestrate",
    sourceConclusion: "requested",
    targetKind: "pull_request",
    targetNumber: "66",
    currentRound: 1,
    maxRounds: 5,
    plannerDecision: {
      decision: "delegate_issue",
      reason: "Try from a PR.",
      childInstructions: "Do it.",
    },
  });
  assert.equal(wrongTarget.decision, "stop");
  assert.match(wrongTarget.reason, /only from issues/);

  const missingInstructions = decideHandoff({
    automationMode: "agent",
    sourceAction: "orchestrate",
    sourceConclusion: "requested",
    targetKind: "issue",
    targetNumber: "76",
    currentRound: 1,
    maxRounds: 5,
    plannerDecision: { decision: "delegate_issue", reason: "No task." },
  });
  assert.equal(missingInstructions.decision, "stop");
  assert.match(missingInstructions.reason, /without child instructions/);

  const mixedCommand = decideHandoff({
    automationMode: "agent",
    sourceAction: "orchestrate",
    sourceConclusion: "requested",
    targetKind: "issue",
    targetNumber: "76",
    currentRound: 1,
    maxRounds: 5,
    plannerDecision: {
      decision: "delegate_issue",
      nextAction: "review",
      reason: "Mixed command.",
      childInstructions: "Do it.",
    },
  });
  assert.equal(mixedCommand.decision, "stop");
  assert.match(mixedCommand.reason, /must not set next_action/);
});

test("agent mode rejects issue-level implement handoffs for non-issue targets", () => {
  const decision = decideHandoff({
    automationMode: "agent",
    sourceAction: "orchestrate",
    sourceConclusion: "requested",
    targetKind: "pull_request",
    targetNumber: "76",
    currentRound: 1,
    maxRounds: 5,
    plannerDecision: {
      decision: "handoff",
      nextAction: "implement",
      reason: "Try to implement from a PR.",
    },
  });

  assert.equal(decision.decision, "stop");
  assert.match(decision.reason, /only for issue targets/);
});

test("agent mode leaves handoff context empty when planner omits it", () => {
  const decision = decideHandoff({
    automationMode: "agent",
    sourceAction: "review",
    sourceConclusion: "minor_issues",
    targetNumber: "99",
    currentRound: 2,
    maxRounds: 5,
    plannerDecision: {
      decision: "handoff",
      nextAction: "fix-pr",
      reason: "Review found minor issues.",
    },
  });

  assert.equal(decision.decision, "dispatch");
  assert.equal(decision.nextAction, "fix-pr");
  assert.equal(decision.handoffContext, undefined);
});

test("agent mode stops invalid or disallowed planner handoffs", () => {
  const disallowed = decideHandoff({
    automationMode: "agent",
    sourceAction: "implement",
    sourceConclusion: "verify_failed",
    targetNumber: "42",
    nextTargetNumber: "99",
    currentRound: 1,
    maxRounds: 5,
    plannerDecision: { decision: "handoff", nextAction: "review", reason: "Try anyway." },
  });
  assert.equal(disallowed.decision, "stop");
  assert.match(disallowed.reason, /policy disallows/);

  const wrongEdge = decideHandoff({
    automationMode: "agent",
    sourceAction: "review",
    sourceConclusion: "minor_issues",
    targetNumber: "99",
    currentRound: 2,
    maxRounds: 5,
    plannerDecision: { decision: "handoff", nextAction: "review", reason: "Review again." },
  });
  assert.equal(wrongEdge.decision, "stop");
  assert.match(wrongEdge.reason, /policy only allows fix-pr/);
});

test("agent mode respects planner stop, invalid planner output, and round budget", () => {
  const stopped = decideHandoff({
    automationMode: "agent",
    sourceAction: "review",
    sourceConclusion: "minor_issues",
    targetNumber: "99",
    currentRound: 2,
    maxRounds: 5,
    plannerDecision: { decision: "stop", reason: "Leave the remaining work to a maintainer." },
  });
  assert.equal(stopped.decision, "stop");
  assert.match(stopped.reason, /agent planner stop/);

  const blocked = decideHandoff({
    automationMode: "agent",
    sourceAction: "orchestrate",
    sourceConclusion: "done",
    targetKind: "issue",
    targetNumber: "76",
    currentRound: 2,
    maxRounds: 5,
    plannerDecision: {
      decision: "blocked",
      reason: "Need the next child scope.",
      userMessage: "I need a maintainer decision before continuing.",
      clarificationRequest: "Should the next child stack on #112?",
    },
  });
  assert.equal(blocked.decision, "stop");
  assert.equal(blocked.plannerDecisionKind, "blocked");
  assert.equal(blocked.userMessage, "I need a maintainer decision before continuing.");
  assert.equal(blocked.clarificationRequest, "Should the next child stack on #112?");
  assert.match(blocked.reason, /agent planner blocked/);

  const invalid = decideHandoff({
    automationMode: "agent",
    sourceAction: "review",
    sourceConclusion: "minor_issues",
    targetNumber: "99",
    currentRound: 2,
    maxRounds: 5,
  });
  assert.equal(invalid.decision, "stop");
  assert.match(invalid.reason, /planner decision missing/);

  const exhausted = decideHandoff({
    automationMode: "agent",
    sourceAction: "review",
    sourceConclusion: "minor_issues",
    targetNumber: "99",
    currentRound: 5,
    maxRounds: 5,
    plannerDecision: { decision: "handoff", nextAction: "fix-pr", reason: "Try another fix pass." },
  });
  assert.equal(exhausted.decision, "stop");
  assert.match(exhausted.reason, /budget/);
});

test("implement success dispatches review for the created PR", () => {
  const decision = decideHandoff({
    automationMode: "heuristics",
    sourceAction: "implement",
    sourceConclusion: "success",
    targetNumber: "42",
    nextTargetNumber: "99",
    currentRound: 1,
    maxRounds: 5,
  });

  assert.equal(decision.decision, "dispatch");
  assert.equal(decision.nextAction, "review");
  assert.equal(decision.targetNumber, "99");
  assert.equal(decision.nextRound, 2);
});

test("implement stops on failures and missing PR targets", () => {
  const failed = decideHandoff({
    automationMode: "heuristics",
    sourceAction: "implement",
    sourceConclusion: "verify_failed",
    targetNumber: "42",
    nextTargetNumber: "99",
    currentRound: 1,
    maxRounds: 5,
  });
  assert.equal(failed.decision, "stop");
  assert.match(failed.reason, /verify_failed/);

  const missingPr = decideHandoff({
    automationMode: "heuristics",
    sourceAction: "implement",
    sourceConclusion: "success",
    targetNumber: "42",
    currentRound: 1,
    maxRounds: 5,
  });
  assert.equal(missingPr.decision, "stop");
  assert.match(missingPr.reason, /pull request target/);
});

test("review verdicts dispatch fix-pr or stop", () => {
  for (const verdict of ["NEEDS_REWORK", "CHANGES_REQUESTED", "minor-issues"]) {
    const needsFix = decideHandoff({
      automationMode: "heuristics",
      sourceAction: "review",
      sourceConclusion: verdict,
      targetNumber: "99",
      currentRound: 2,
      maxRounds: 5,
    });

    assert.equal(needsFix.decision, "dispatch");
    assert.equal(needsFix.nextAction, "fix-pr");
    assert.equal(needsFix.targetNumber, "99");
  }

  const ship = decideHandoff({
    automationMode: "heuristics",
    sourceAction: "review",
    sourceConclusion: "SHIP",
    targetNumber: "99",
    currentRound: 2,
    maxRounds: 5,
  });

  assert.equal(ship.decision, "stop");
  assert.match(ship.reason, /SHIP/);
});

test("fix-pr success dispatches review until the round budget is exhausted", () => {
  const decision = decideHandoff({
    automationMode: "heuristics",
    sourceAction: "fix-pr",
    sourceConclusion: "success",
    targetNumber: "99",
    currentRound: 4,
    maxRounds: 5,
  });

  assert.equal(decision.decision, "dispatch");
  assert.equal(decision.nextAction, "review");

  const exhausted = decideHandoff({
    automationMode: "heuristics",
    sourceAction: "fix-pr",
    sourceConclusion: "success",
    targetNumber: "99",
    currentRound: 5,
    maxRounds: 5,
  });

  assert.equal(exhausted.decision, "stop");
  assert.match(exhausted.reason, /budget/);
});

test("fix-pr unsatisfactory conclusions stop without re-review", () => {
  for (const conclusion of ["no_changes", "failed", "verify_failed"]) {
    const decision = decideHandoff({
      automationMode: "heuristics",
      sourceAction: "fix-pr",
      sourceConclusion: conclusion,
      targetNumber: "99",
      currentRound: 3,
      maxRounds: 5,
    });

    assert.equal(decision.decision, "stop");
    assert.equal(decision.nextAction, undefined);
    assert.match(decision.reason, new RegExp(`fix-pr concluded ${conclusion}`));
    assert.match(decision.reason, /must succeed before re-review/);
  }
});

test("unsupported actions stop", () => {
  const decision = decideHandoff({
    automationMode: "heuristics",
    sourceAction: "deploy",
    sourceConclusion: "success",
    targetNumber: "99",
    currentRound: 1,
    maxRounds: 5,
  });

  assert.equal(decision.decision, "stop");
  assert.match(decision.reason, /unsupported/);
});

test("extractReviewConclusion reads final verdict markdown", () => {
  assert.equal(extractReviewConclusion("## Final Verdict\n- `MINOR_ISSUES`"), "minor_issues");
  assert.equal(extractReviewConclusion("Final answer\n\n## Final Verdict\nSHIP"), "ship");
  assert.equal(extractReviewConclusion("This needs-rework before another pass"), "needs_rework");
  assert.equal(extractReviewConclusion("No verdict here"), "unknown");
});

test("handoff dedupe markers are deterministic and detectable", () => {
  const key = buildHandoffDedupeKey({
    repo: "Self-Evolving/Repo",
    sourceRunId: "12345",
    sourceAction: "fix-pr",
    sourceTargetNumber: "99",
    nextAction: "review",
    nextTargetNumber: "99",
    nextRound: 3,
  });

  assert.equal(key, "handoff:self-evolving/repo:12345:fix_pr:99:review:99:3");
  const marker = buildHandoffMarker(key, "pending", 1_000);
  assert.ok(hasHandoffMarker(`comment body\n${marker}`, key));
  assert.equal(getHandoffMarkerState(`comment body\n${marker}`, key), "pending");
  assert.deepEqual(parseHandoffMarker(marker, key), { state: "pending", createdAtMs: 1_000 });
  assert.equal(getHandoffMarkerState(buildHandoffMarker(key, "failed"), key), "failed");
  assert.equal(getHandoffMarkerState(buildHandoffMarker(key), key), "dispatched");
  assert.equal(hasHandoffMarker("comment body", key), false);
});

test("pending handoff markers become stale after the ttl", () => {
  assert.equal(
    isPendingHandoffMarkerStale({ state: "pending", createdAtMs: 1_000 }, 3_000, 1_000),
    true,
  );
  assert.equal(
    isPendingHandoffMarkerStale({ state: "pending", createdAtMs: 2_500 }, 3_000, 1_000),
    false,
  );
  assert.equal(
    isPendingHandoffMarkerStale({ state: "pending", createdAtMs: null }, 3_000, 1_000),
    true,
  );
  assert.equal(
    isPendingHandoffMarkerStale({ state: "dispatched", createdAtMs: 1_000 }, 3_000, 1_000),
    false,
  );
});

test("automation mode parsing supports disabled, heuristics, and boolean compatibility aliases", () => {
  assert.equal(normalizeAutomationMode("disabled"), "disabled");
  assert.equal(normalizeAutomationMode("false"), "disabled");
  assert.equal(normalizeAutomationMode("heuristics"), "heuristics");
  assert.equal(normalizeAutomationMode("true"), "heuristics");
  assert.equal(normalizeAutomationMode("agent"), "agent");
  assert.equal(normalizeAutomationMode("heuristic"), "disabled");
  assert.equal(normalizeAutomationMode("deterministic"), "disabled");
  assert.equal(automationModeAllowsHandoff("heuristics"), true);
  assert.equal(automationModeAllowsHandoff("agent"), true);
  assert.equal(automationModeAllowsHandoff("heuristic"), false);
  assert.equal(automationModeAllowsHandoff("deterministic"), false);
});

test("parsePlannerDecision reads planner JSON", () => {
  assert.deepEqual(
    parsePlannerDecision(
      [
        "```json",
        '{"decision":"handoff","next_action":"fix-pr","reason":"Needs changes.","handoff_context":"Only update tests for the failing review findings."}',
        "```",
      ].join("\n"),
    ),
    {
      decision: "handoff",
      nextAction: "fix-pr",
      reason: "Needs changes.",
      handoffContext: "Only update tests for the failing review findings.",
    },
  );
  assert.deepEqual(
    parsePlannerDecision(
      '{"decision":"blocked","reason":"Missing PR.","user_message":"I need the PR number.","clarification_request":"Which PR should I inspect?"}',
    ),
    {
      decision: "blocked",
      nextAction: undefined,
      reason: "Missing PR.",
      userMessage: "I need the PR number.",
      clarificationRequest: "Which PR should I inspect?",
    },
  );
  assert.equal(
    parsePlannerDecision(
      '{"decision":"handoff","nextAction":"fix-pr","reason":"Alias.","handoffContext":"camel case works"}',
    )?.handoffContext,
    "camel case works",
  );
  assert.deepEqual(
    parsePlannerDecision(
      '{"decision":"delegate_issue","reason":"Delegate.","child_stage":"Stage One","child_instructions":"Do one thing.","base_pr":"12"}',
    ),
    {
      decision: "delegate_issue",
      nextAction: undefined,
      reason: "Delegate.",
      childStage: "Stage One",
      childInstructions: "Do one thing.",
      basePr: "12",
    },
  );
  assert.equal(parsePlannerDecision("not json"), null);
  assert.equal(parsePlannerDecision('{"decision":"handoff","next_action":"deploy"}')?.nextAction, undefined);
});
