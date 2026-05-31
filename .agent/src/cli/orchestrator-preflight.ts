// CLI: compute cheap preflight outputs for agent-orchestrator.yml.
// Env: AUTOMATION_MODE, AUTOMATION_CURRENT_ROUND, AUTOMATION_MAX_ROUNDS,
//      SOURCE_ACTION, SOURCE_CONCLUSION, SOURCE_RECOMMENDED_NEXT_STEP,
//      TARGET_KIND, TARGET_NUMBER, NEXT_TARGET_NUMBER, SOURCE_HANDOFF_CONTEXT,
//      AUTHOR_ASSOCIATION, ACCESS_POLICY, REPOSITORY_PRIVATE,
//      AGENT_ALLOW_SELF_APPROVE, AGENT_ALLOW_SELF_MERGE
// Outputs: automation_mode, current_round, max_rounds, planner_enabled,
//          authorization_stop, authorization_stop_reason, suggested_decision,
//          suggested_next_action, suggested_reason, suggested_handoff_context
// The authorization_stop outputs are diagnostic; planner_enabled is the workflow gate,
// and orchestrate-handoff posts the parent-visible stop comment.

import { computeDeterministicSuggestion, normalizeAutomationMode } from "../handoff.js";
import { initialOrchestrateCapabilityStopReason } from "../orchestrator-capabilities.js";
import { setOutput } from "../output.js";

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlagEnabled(value: string): boolean {
  return ["true", "1", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

const automationMode = normalizeAutomationMode(process.env.AUTOMATION_MODE || "disabled");
const currentRound = positiveInt(process.env.AUTOMATION_CURRENT_ROUND || "", 1);
const maxRounds = positiveInt(process.env.AUTOMATION_MAX_ROUNDS || "", 12);
const sourceAction = String(process.env.SOURCE_ACTION || "").trim().toLowerCase();
const sourceConclusion = String(process.env.SOURCE_CONCLUSION || "unknown").trim().toLowerCase();
const sourceRecommendedNextStep = String(process.env.SOURCE_RECOMMENDED_NEXT_STEP || "").trim();
const sourceHandoffContext = String(process.env.SOURCE_HANDOFF_CONTEXT || "").trim();
const targetKind = String(process.env.TARGET_KIND || "").trim().toLowerCase();
const targetNumber = String(process.env.TARGET_NUMBER || "").trim();
const nextTargetNumber = String(process.env.NEXT_TARGET_NUMBER || "").trim();
const authorizationStopReason = initialOrchestrateCapabilityStopReason({
  sourceAction,
  sourceConclusion,
  currentRound,
  allowSelfApprove: envFlagEnabled(process.env.AGENT_ALLOW_SELF_APPROVE || ""),
  allowSelfMerge: envFlagEnabled(process.env.AGENT_ALLOW_SELF_MERGE || ""),
  authorAssociation: process.env.AUTHOR_ASSOCIATION || "",
  accessPolicy: process.env.ACCESS_POLICY || "",
  isPublicRepo: String(process.env.REPOSITORY_PRIVATE || "").trim().toLowerCase() === "false",
});
const initialOrchestrate = sourceAction === "orchestrate";
const plannerEnabled = !authorizationStopReason &&
  automationMode === "agent" &&
  currentRound < maxRounds &&
  (!initialOrchestrate || targetKind === "issue" || targetKind === "pull_request");
const suggestion = computeDeterministicSuggestion({
  automationMode,
  sourceAction,
  sourceConclusion,
  sourceRecommendedNextStep,
  sourceHandoffContext,
  targetKind,
  targetNumber,
  nextTargetNumber,
  currentRound,
  maxRounds,
  allowSelfApprove: envFlagEnabled(process.env.AGENT_ALLOW_SELF_APPROVE || ""),
  allowSelfMerge: envFlagEnabled(process.env.AGENT_ALLOW_SELF_MERGE || ""),
});

setOutput("automation_mode", automationMode);
setOutput("current_round", String(currentRound));
setOutput("max_rounds", String(maxRounds));
setOutput("planner_enabled", String(plannerEnabled));
setOutput("authorization_stop", String(Boolean(authorizationStopReason)));
setOutput("authorization_stop_reason", authorizationStopReason);
setOutput("suggested_decision", suggestion.suggestedDecision);
setOutput("suggested_next_action", suggestion.suggestedNextAction || "");
setOutput("suggested_reason", suggestion.suggestedReason);
setOutput("suggested_handoff_context", suggestion.suggestedHandoffContext || "");

console.log(
  `Orchestrator preflight: mode=${automationMode}, source_action=${sourceAction || "missing"}, target_kind=${targetKind || "missing"}, round=${currentRound}/${maxRounds}, planner_enabled=${plannerEnabled}, authorization_stop=${Boolean(authorizationStopReason)}, suggested_decision=${suggestion.suggestedDecision}`,
);
