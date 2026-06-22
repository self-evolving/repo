#!/usr/bin/env node
// CLI: resolve live progress reporting policy for a run-agent-task invocation.
//
// Env:
//   ROUTE                    current route
//   TARGET_KIND              issue, pull_request, discussion, repository, ...
//   AGENT_PROGRESS_POLICY    raw JSON policy string
//
// Outputs:
//   mode                     enabled | report-only | disabled
//   enabled                  "true" | "false"
//   cancel_enabled           "true" | "false"
//   target_supported         "true" | "false"

import { setOutput } from "../../output.js";
import {
  getProgressModeForRoute,
  parseProgressPolicy,
  progressModeAllowsCancel,
  progressModeAllowsComment,
  progressTargetSupportsComments,
  type ProgressMode,
} from "../../progress-policy.js";

export function resolveProgressMode(env: NodeJS.ProcessEnv = process.env): ProgressMode {
  const route = String(env.ROUTE || "").trim().toLowerCase();

  try {
    const policy = parseProgressPolicy(env.AGENT_PROGRESS_POLICY || "");
    return getProgressModeForRoute(policy, route);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid AGENT_PROGRESS_POLICY: ${msg}. Falling back to disabled.`);
    return "disabled";
  }
}

export function runProgressResolvePolicyCli(env: NodeJS.ProcessEnv = process.env): number {
  const mode = resolveProgressMode(env);
  const enabled = progressModeAllowsComment(mode);
  const cancelEnabled = progressModeAllowsCancel(mode);
  const targetSupported = progressTargetSupportsComments(env.TARGET_KIND || "");

  setOutput("mode", mode);
  setOutput("enabled", String(enabled));
  setOutput("cancel_enabled", String(cancelEnabled));
  setOutput("target_supported", String(targetSupported));
  console.log(
    `progress mode: ${mode}; target_supported=${targetSupported}; cancel_enabled=${cancelEnabled}`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = runProgressResolvePolicyCli();
}
