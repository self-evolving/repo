// CLI: compute cheap preflight outputs for agent-orchestrator.yml.
// Env: AUTOMATION_MODE, AUTOMATION_CURRENT_ROUND, AUTOMATION_MAX_ROUNDS,
//      SOURCE_ACTION, SOURCE_CONCLUSION, TARGET_NUMBER, NEXT_TARGET_NUMBER
// Outputs: automation_mode, current_round, max_rounds, planner_enabled

import { decideHandoff, normalizeAutomationMode } from "../handoff.js";
import { setOutput } from "../output.js";

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const automationMode = normalizeAutomationMode(process.env.AUTOMATION_MODE || "disabled");
const currentRound = positiveInt(process.env.AUTOMATION_CURRENT_ROUND || "", 1);
const maxRounds = positiveInt(process.env.AUTOMATION_MAX_ROUNDS || "", 5);
const heuristicDecision = decideHandoff({
  automationMode: "heuristics",
  sourceAction: process.env.SOURCE_ACTION || "",
  sourceConclusion: process.env.SOURCE_CONCLUSION || "",
  targetNumber: process.env.TARGET_NUMBER || "",
  nextTargetNumber: process.env.NEXT_TARGET_NUMBER || "",
  currentRound,
  maxRounds,
});
const plannerEnabled = automationMode === "agent" && heuristicDecision.decision === "dispatch";

setOutput("automation_mode", automationMode);
setOutput("current_round", String(currentRound));
setOutput("max_rounds", String(maxRounds));
setOutput("planner_enabled", String(plannerEnabled));

console.log(
  `Orchestrator preflight: mode=${automationMode}, round=${currentRound}/${maxRounds}, planner_enabled=${plannerEnabled}`,
);
