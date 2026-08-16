#!/usr/bin/env node
// CLI: publish the initial report-only progress note for an orchestrator run.
// This runs in a deterministic write-scoped job; the agent planner remains read-only.
//
// Env: AGENT_PROGRESS_POLICY, GITHUB_REPOSITORY, GITHUB_RUN_ID, ROUTE,
//      TARGET_KIND, TARGET_NUMBER
// Output: progress_comment_id

import {
  createIssueComment,
  findLatestTrustedIssueCommentByMarker,
  updateIssueComment,
} from "../github.js";
import { setOutput } from "../output.js";
import { resolveProgressPolicy } from "./progress/resolve-policy.js";
import {
  buildProgressViewModel,
  progressMarker,
  renderRunning,
} from "../progress-render.js";

function positiveTargetNumber(value: string): number {
  const normalized = String(value || "").trim();
  if (!/^\d+$/.test(normalized)) return 0;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function runPublishOrchestrationProgressCli(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const route = String(env.ROUTE || "orchestrator").trim() || "orchestrator";
  const resolution = resolveProgressPolicy({
    ...env,
    ORCHESTRATION_ENABLED: "true",
    ROUTE: route,
  });

  if (!resolution.enabled || !resolution.targetSupported) {
    console.log(
      `orchestration progress skipped: mode=${resolution.mode}; target_supported=${resolution.targetSupported}`,
    );
    return 0;
  }

  const repo = String(env.GITHUB_REPOSITORY || "").trim();
  const targetNumber = positiveTargetNumber(env.TARGET_NUMBER || "");
  if (!repo || !targetNumber) {
    throw new Error("GITHUB_REPOSITORY and a positive TARGET_NUMBER are required");
  }

  const runId = String(env.GITHUB_RUN_ID || "unknown");
  const body = renderRunning(buildProgressViewModel("", {
    runId,
    route,
  }));
  const existing = findLatestTrustedIssueCommentByMarker(
    targetNumber,
    repo,
    progressMarker(runId),
  );
  const commentId = existing?.id || createIssueComment(repo, targetNumber, body);
  if (!commentId) {
    throw new Error("GitHub returned an empty orchestration progress comment id");
  }
  if (existing) {
    updateIssueComment(repo, commentId, body);
  }

  setOutput("progress_comment_id", commentId);
  console.log(`${existing ? "Updated" : "Published"} orchestration progress comment ${commentId}.`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = runPublishOrchestrationProgressCli();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to publish orchestration progress: ${message}`);
    process.exitCode = 1;
  }
}
