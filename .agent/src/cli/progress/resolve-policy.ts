#!/usr/bin/env node
// CLI: resolve live progress reporting policy for a run-agent-task invocation.
//
// Env:
//   ROUTE                    current route
//   TARGET_KIND              issue, pull_request, discussion, repository, ...
//   AGENT_PROGRESS_POLICY    raw JSON policy string
//   ORCHESTRATION_ENABLED    true when this run belongs to an orchestrated chain
//
// Outputs:
//   mode                     enabled | report-only | disabled
//   enabled                  "true" | "false"
//   cancel_enabled           "true" | "false"
//   target_supported         "true" | "false"
//   response_supported       "true" | "false"

import { setOutput } from "../../output.js";
import {
  getProgressModeForOrchestration,
  getProgressModeForRoute,
  parseProgressPolicy,
  progressModeAllowsCancel,
  progressModeAllowsComment,
  progressResponseSupportsComments,
  progressTargetSupportsComments,
  type ProgressMode,
} from "../../progress-policy.js";

export interface ProgressPolicyResolution {
  mode: ProgressMode;
  enabled: boolean;
  cancelEnabled: boolean;
  targetSupported: boolean;
  responseSupported: boolean;
}

export function resolveProgressMode(env: NodeJS.ProcessEnv = process.env): ProgressMode {
  const orchestrationEnabled =
    String(env.ORCHESTRATION_ENABLED || "").trim().toLowerCase() === "true";
  const route = String(env.ROUTE || "").trim().toLowerCase();

  try {
    const policy = parseProgressPolicy(env.AGENT_PROGRESS_POLICY || "");
    if (orchestrationEnabled) {
      return getProgressModeForOrchestration(policy);
    }
    return getProgressModeForRoute(policy, route);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid AGENT_PROGRESS_POLICY: ${msg}. Falling back to disabled.`);
    return "disabled";
  }
}

export function resolveProgressPolicy(env: NodeJS.ProcessEnv = process.env): ProgressPolicyResolution {
  const mode = resolveProgressMode(env);
  const responseSupported = progressResponseSupportsComments(
    env.ROUTE || "",
    env.RESPONSE_KIND || "",
  );
  return {
    mode,
    enabled: progressModeAllowsComment(mode) && responseSupported,
    cancelEnabled: progressModeAllowsCancel(mode) && responseSupported,
    targetSupported: progressTargetSupportsComments(env.TARGET_KIND || ""),
    responseSupported,
  };
}

export function runProgressResolvePolicyCli(env: NodeJS.ProcessEnv = process.env): number {
  const resolution = resolveProgressPolicy(env);

  setOutput("mode", resolution.mode);
  setOutput("enabled", String(resolution.enabled));
  setOutput("cancel_enabled", String(resolution.cancelEnabled));
  setOutput("target_supported", String(resolution.targetSupported));
  setOutput("response_supported", String(resolution.responseSupported));
  console.log(
    `progress mode: ${resolution.mode}; target_supported=${resolution.targetSupported}; response_supported=${resolution.responseSupported}; cancel_enabled=${resolution.cancelEnabled}`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = runProgressResolvePolicyCli();
}
