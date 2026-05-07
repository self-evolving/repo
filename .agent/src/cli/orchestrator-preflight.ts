// CLI: compute cheap preflight outputs for agent-orchestrator.yml.
// Env: AUTOMATION_MODE, AUTOMATION_CURRENT_ROUND, AUTOMATION_MAX_ROUNDS,
//      SOURCE_ACTION, SOURCE_CONCLUSION, TARGET_KIND, AUTHOR_ASSOCIATION,
//      ACCESS_POLICY, REPOSITORY_PRIVATE, AGENT_ALLOW_SELF_APPROVE
// Outputs: automation_mode, current_round, max_rounds, planner_enabled,
//          authorization_stop, authorization_stop_reason
// The authorization_stop outputs are diagnostic; planner_enabled is the workflow gate,
// and orchestrate-handoff posts the parent-visible stop comment.

import { normalizeAutomationMode } from "../handoff.js";
import { initialOrchestrateCapabilityStopReason } from "../orchestrator-capabilities.js";
import { setOutput } from "../output.js";

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const automationMode = normalizeAutomationMode(process.env.AUTOMATION_MODE || "disabled");
const currentRound = positiveInt(process.env.AUTOMATION_CURRENT_ROUND || "", 1);
const maxRounds = positiveInt(process.env.AUTOMATION_MAX_ROUNDS || "", 5);
const sourceAction = String(process.env.SOURCE_ACTION || "").trim().toLowerCase();
const sourceConclusion = String(process.env.SOURCE_CONCLUSION || "unknown").trim().toLowerCase();
const targetKind = String(process.env.TARGET_KIND || "").trim().toLowerCase();
const selfApproveEnabled = ["true", "1", "yes", "on"].includes(
  String(process.env.AGENT_ALLOW_SELF_APPROVE || "").trim().toLowerCase(),
);
const authorizationStopReason = initialOrchestrateCapabilityStopReason({
  sourceAction,
  sourceConclusion,
  currentRound,
  authorAssociation: process.env.AUTHOR_ASSOCIATION || "",
  accessPolicy: process.env.ACCESS_POLICY || "",
  isPublicRepo: String(process.env.REPOSITORY_PRIVATE || "").trim().toLowerCase() === "false",
  selfApproveEnabled,
});
const plannerEnabled = !authorizationStopReason &&
  automationMode === "agent" &&
  currentRound < maxRounds &&
  (sourceAction !== "orchestrate" || targetKind === "issue");

setOutput("automation_mode", automationMode);
setOutput("current_round", String(currentRound));
setOutput("max_rounds", String(maxRounds));
setOutput("planner_enabled", String(plannerEnabled));
setOutput("authorization_stop", String(Boolean(authorizationStopReason)));
setOutput("authorization_stop_reason", authorizationStopReason);

console.log(
  `Orchestrator preflight: mode=${automationMode}, source_action=${sourceAction || "missing"}, target_kind=${targetKind || "missing"}, round=${currentRound}/${maxRounds}, planner_enabled=${plannerEnabled}, authorization_stop=${Boolean(authorizationStopReason)}`,
);
