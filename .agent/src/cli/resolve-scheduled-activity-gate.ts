#!/usr/bin/env node
// CLI: resolve whether a scheduled workflow should skip expensive work.

import { resolveScheduledActivityGate, type PushOptions } from "../scheduled-activity.js";
import { setOutput } from "../output.js";

function buildOptions(): PushOptions {
  const repo = process.env.GITHUB_REPOSITORY || process.env.REPO_SLUG || "";
  const token = process.env.INPUT_GITHUB_TOKEN || process.env.GH_TOKEN || "";
  return { repo, token: token || undefined };
}

try {
  const result = resolveScheduledActivityGate({
    eventName: process.env.GITHUB_EVENT_NAME || "",
    schedulePolicy: process.env.AGENT_SCHEDULE_POLICY || "",
    workflow: process.env.WORKFLOW_FILENAME || "",
    activityCount: process.env.ACTIVITY_COUNT || "",
    dependencyRef: process.env.DEPENDENCY_REF || "",
    dependencyField: process.env.DEPENDENCY_FIELD || "",
    selfRef: process.env.SELF_REF || "",
    selfField: process.env.SELF_FIELD || "",
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    pushOptions: buildOptions(),
  });

  setOutput("skip", result.skip ? "true" : "false");
  setOutput("mode", result.mode);
  setOutput("reason", result.reason);
  setOutput("dependency_value", result.dependencyValue);
  setOutput("self_value", result.selfValue);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Invalid scheduled activity gate configuration: ${message}`);
  process.exitCode = 2;
}
