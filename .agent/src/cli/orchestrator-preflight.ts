// CLI: compute cheap preflight outputs for agent-orchestrator.yml.
// Env: AUTOMATION_MODE, AUTOMATION_CURRENT_ROUND, AUTOMATION_MAX_ROUNDS, SOURCE_ACTION, TARGET_KIND
// Outputs: automation_mode, current_round, max_rounds, planner_enabled

import { normalizeAutomationMode } from "../handoff.js";
import { setOutput } from "../output.js";

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const automationMode = normalizeAutomationMode(process.env.AUTOMATION_MODE || "disabled");
const currentRound = positiveInt(process.env.AUTOMATION_CURRENT_ROUND || "", 1);
const maxRounds = positiveInt(process.env.AUTOMATION_MAX_ROUNDS || "", 5);
const sourceAction = String(process.env.SOURCE_ACTION || "").trim().toLowerCase();
const targetKind = String(process.env.TARGET_KIND || "").trim().toLowerCase();
const plannerEnabled = automationMode === "agent" &&
  currentRound < maxRounds &&
  (sourceAction !== "orchestrate" || targetKind === "issue");

setOutput("automation_mode", automationMode);
setOutput("current_round", String(currentRound));
setOutput("max_rounds", String(maxRounds));
setOutput("planner_enabled", String(plannerEnabled));

console.log(
  `Orchestrator preflight: mode=${automationMode}, source_action=${sourceAction || "missing"}, target_kind=${targetKind || "missing"}, round=${currentRound}/${maxRounds}, planner_enabled=${plannerEnabled}`,
);
