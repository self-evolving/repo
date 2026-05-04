// CLI: dispatch agent-orchestrator.yml with a post-action handoff envelope.
// Env: GITHUB_REPOSITORY, DEFAULT_BRANCH, AUTOMATION_MODE, SOURCE_ACTION,
//      SOURCE_CONCLUSION, RESPONSE_FILE, TARGET_NUMBER, NEXT_TARGET_NUMBER,
//      REQUESTED_BY, REQUEST_TEXT, AUTOMATION_CURRENT_ROUND,
//      AUTOMATION_MAX_ROUNDS, SESSION_BUNDLE_MODE, SOURCE_RUN_ID, TARGET_KIND,
//      AUTHOR_ASSOCIATION, ACCESS_POLICY, REPOSITORY_PRIVATE, ORCHESTRATION_ENABLED,
//      SOURCE_HANDOFF_CONTEXT, BASE_BRANCH, BASE_PR

import { readFileSync } from "node:fs";
import { dispatchWorkflow } from "../github.js";
import {
  automationModeAllowsHandoff,
  buildReviewFixPrHandoffContext,
  extractReviewConclusion,
  normalizeConclusion,
} from "../handoff.js";

function readResponseFile(): string {
  const responseFile = process.env.RESPONSE_FILE || "";
  if (!responseFile) return "";
  try {
    return readFileSync(responseFile, "utf8");
  } catch {
    return "";
  }
}

function sourceReviewNeedsFixPr(sourceAction: string, sourceConclusion: string): boolean {
  if (sourceAction.trim().toLowerCase() !== "review") return false;
  return new Set(["minor_issues", "needs_rework", "changes_requested"]).has(normalizeConclusion(sourceConclusion));
}

const automationMode = process.env.AUTOMATION_MODE || "disabled";
const sourceAction = process.env.SOURCE_ACTION || "";
const isManualOrchestrateStart = sourceAction.trim().toLowerCase() === "orchestrate";
const orchestrationEnabled = String(process.env.ORCHESTRATION_ENABLED || "").trim().toLowerCase() === "true";
if (!isManualOrchestrateStart && !orchestrationEnabled && !automationModeAllowsHandoff(automationMode)) {
  console.log("Skipping orchestrator dispatch: automation mode is disabled");
  process.exit(0);
}
const effectiveAutomationMode = orchestrationEnabled && !automationModeAllowsHandoff(automationMode)
  ? "heuristics"
  : automationMode;

const repo = process.env.GITHUB_REPOSITORY || "";
const ref = process.env.DEFAULT_BRANCH || "";
const rawResponse = readResponseFile();
const sourceConclusion = process.env.SOURCE_CONCLUSION || extractReviewConclusion(rawResponse) || "unknown";
const sourceHandoffContext = process.env.SOURCE_HANDOFF_CONTEXT ||
  (sourceReviewNeedsFixPr(sourceAction, sourceConclusion) ? buildReviewFixPrHandoffContext(rawResponse) : "");
const targetNumber = process.env.TARGET_NUMBER || "";
const targetKind = process.env.TARGET_KIND || "";

if (!repo || !ref || !sourceAction || !targetNumber) {
  console.error("Missing required env: GITHUB_REPOSITORY, DEFAULT_BRANCH, SOURCE_ACTION, TARGET_NUMBER");
  process.exit(2);
}

dispatchWorkflow(repo, "agent-orchestrator.yml", ref, {
  automation_mode: effectiveAutomationMode,
  automation_current_round: process.env.AUTOMATION_CURRENT_ROUND || "1",
  automation_max_rounds: process.env.AUTOMATION_MAX_ROUNDS || "5",
  source_action: sourceAction,
  source_conclusion: sourceConclusion,
  source_run_id: process.env.SOURCE_RUN_ID || process.env.GITHUB_RUN_ID || "",
  target_kind: targetKind,
  target_number: targetNumber,
  author_association: process.env.AUTHOR_ASSOCIATION || "",
  access_policy: process.env.ACCESS_POLICY || "",
  repository_private: process.env.REPOSITORY_PRIVATE || "",
  next_target_number: process.env.NEXT_TARGET_NUMBER || "",
  source_handoff_context: sourceHandoffContext,
  requested_by: process.env.REQUESTED_BY || "",
  request_text: process.env.REQUEST_TEXT || "",
  session_bundle_mode: process.env.SESSION_BUNDLE_MODE || "",
  base_branch: process.env.BASE_BRANCH || "",
  base_pr: process.env.BASE_PR || "",
});

console.log(`Dispatched agent-orchestrator.yml after ${sourceAction} for #${targetNumber}`);
