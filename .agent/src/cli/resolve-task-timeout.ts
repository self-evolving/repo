#!/usr/bin/env node
// CLI: resolve the GitHub Actions step timeout for a run-agent-task invocation.
//
// Env:
//   ROUTE                      current route (e.g., answer, review)
//   AGENT_TASK_TIMEOUT_POLICY  raw JSON policy string (optional)
//
// Outputs:
//   minutes                    resolved positive integer timeout

import { setOutput } from "../output.js";
import {
  getTaskTimeoutMinutesForRoute,
  parseTaskTimeoutPolicy,
} from "../task-timeout-policy.js";

export function resolveTaskTimeoutMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const route = String(env.ROUTE || "").trim().toLowerCase();
  const policy = parseTaskTimeoutPolicy(env.AGENT_TASK_TIMEOUT_POLICY || "");
  return getTaskTimeoutMinutesForRoute(policy, route);
}

export function runResolveTaskTimeoutCli(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const minutes = resolveTaskTimeoutMinutes(env);
    setOutput("minutes", String(minutes));
    console.log(`task timeout: ${minutes} minutes`);
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid AGENT_TASK_TIMEOUT_POLICY: ${msg}`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = runResolveTaskTimeoutCli();
}
