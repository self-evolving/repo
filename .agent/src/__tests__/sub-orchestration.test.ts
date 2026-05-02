import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  extractClosingIssueNumber,
  formatSubOrchestrationIssueBody,
  formatSubOrchestratorChildLinkMarker,
  formatSubOrchestratorMarker,
  normalizeSubOrchestratorStage,
  parseSubOrchestratorChildLinkMarker,
  parseSubOrchestratorMarker,
  resultStateFromTerminal,
  updateSubOrchestratorMarkerParentRound,
  updateSubOrchestratorMarkerState,
} from "../sub-orchestration.js";

test("sub-orchestrator markers format, parse, and update", () => {
  const marker = formatSubOrchestratorMarker({
    parent: 76,
    stage: "Stage One!",
    parentRound: 2,
  });

  assert.equal(marker, "<!-- sepo-sub-orchestrator parent:76 stage:stage-one state:running parent_round:2 -->");
  assert.deepEqual(parseSubOrchestratorMarker(marker), {
    parent: 76,
    stage: "stage-one",
    state: "running",
    parentRound: 2,
  });
  assert.equal(normalizeSubOrchestratorStage("  A / B  "), "a-b");
  assert.match(updateSubOrchestratorMarkerState(marker, "done"), /state:done/);
  assert.match(updateSubOrchestratorMarkerParentRound(marker, 4), /parent_round:4/);
});

test("sub-orchestrator child link markers format and parse", () => {
  const marker = formatSubOrchestratorChildLinkMarker({
    parent: 76,
    stage: "Stage One",
    child: 77,
  });

  assert.equal(marker, "<!-- sepo-sub-orchestrator-child parent:76 stage:stage-one child:77 -->");
  assert.deepEqual(parseSubOrchestratorChildLinkMarker(marker), {
    parent: 76,
    stage: "stage-one",
    child: 77,
  });
  assert.equal(parseSubOrchestratorChildLinkMarker("no marker"), null);
});

test("sub-orchestration issue body records visible task and hidden marker", () => {
  const body = formatSubOrchestrationIssueBody({
    parentIssue: 76,
    stage: "Stage One",
    taskInstructions: "Implement the first stage.",
    basePr: "66",
    parentRound: 2,
  });

  assert.match(body, /Parent issue: #76/);
  assert.match(body, /Stage: Stage One/);
  assert.match(body, /Implement the first stage/);
  assert.match(body, /base_pr: #66/);
  assert.deepEqual(parseSubOrchestratorMarker(body), {
    parent: 76,
    stage: "stage-one",
    state: "running",
    parentRound: 2,
  });
});

test("terminal helpers resolve closing issue references and result states", () => {
  assert.equal(extractClosingIssueNumber("Implements #76"), 76);
  assert.equal(extractClosingIssueNumber("Fixes self-evolving/repo#76", "self-evolving/repo"), 76);
  assert.equal(extractClosingIssueNumber("Fixes other-org/other-repo#76", "self-evolving/repo"), null);
  assert.equal(extractClosingIssueNumber("Fixes self-evolving/repo#76"), null);
  assert.equal(extractClosingIssueNumber("No linked issue"), null);
  assert.equal(resultStateFromTerminal({ sourceAction: "review", sourceConclusion: "SHIP", reason: "" }), "done");
  assert.equal(
    resultStateFromTerminal({
      sourceAction: "review",
      sourceConclusion: "failed",
      reason: "orchestrate requests require implement access; implement currently requires MEMBER access.",
    }),
    "blocked",
  );
  assert.equal(
    resultStateFromTerminal({
      sourceAction: "review",
      sourceConclusion: "failed",
      reason: "invalid AGENT_ACCESS_POLICY: Access policy must be a JSON object",
    }),
    "failed",
  );
  assert.equal(
    resultStateFromTerminal({
      sourceAction: "implement",
      sourceConclusion: "failed",
      reason: "automation round budget exhausted",
    }),
    "blocked",
  );
  assert.equal(
    resultStateFromTerminal({
      sourceAction: "orchestrate",
      sourceConclusion: "failed",
      reason: "agent planner blocked: waiting for user input",
    }),
    "blocked",
  );
  assert.equal(
    resultStateFromTerminal({
      sourceAction: "implement",
      sourceConclusion: "failed",
      reason: "provider said blocked while parsing output",
    }),
    "failed",
  );
  assert.equal(resultStateFromTerminal({ sourceAction: "implement", sourceConclusion: "failed", reason: "" }), "failed");
});
