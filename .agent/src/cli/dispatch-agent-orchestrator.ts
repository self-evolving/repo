// CLI: dispatch agent-orchestrator.yml with a post-action handoff envelope.
// Env: GITHUB_REPOSITORY, DEFAULT_BRANCH, AUTOMATION_MODE, SOURCE_ACTION,
//      SOURCE_CONCLUSION, RESPONSE_FILE, TARGET_NUMBER, NEXT_TARGET_NUMBER,
//      REQUESTED_BY, REQUEST_TEXT, SOURCE_COMMENT_URL, AUTOMATION_CURRENT_ROUND,
//      AUTOMATION_MAX_ROUNDS, SESSION_BUNDLE_MODE, SOURCE_RUN_ID, TARGET_KIND,
//      AUTHOR_ASSOCIATION, ACCESS_POLICY, REPOSITORY_PRIVATE, ORCHESTRATION_ENABLED

import { readFileSync } from "node:fs";
import { dispatchWorkflow } from "../github.js";
import { automationModeAllowsHandoff, extractReviewConclusion } from "../handoff.js";

function readResponseConclusion(): string {
  const responseFile = process.env.RESPONSE_FILE || "";
  if (!responseFile) return "";
  try {
    return extractReviewConclusion(readFileSync(responseFile, "utf8"));
  } catch {
    return "";
  }
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
const sourceConclusion = process.env.SOURCE_CONCLUSION || readResponseConclusion() || "unknown";
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
  requested_by: process.env.REQUESTED_BY || "",
  request_text: process.env.REQUEST_TEXT || "",
  source_comment_url: process.env.SOURCE_COMMENT_URL || "",
  session_bundle_mode: process.env.SESSION_BUNDLE_MODE || "",
});

console.log(`Dispatched agent-orchestrator.yml after ${sourceAction} for #${targetNumber}`);
