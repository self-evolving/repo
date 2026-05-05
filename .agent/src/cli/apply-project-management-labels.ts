#!/usr/bin/env node
// CLI: deterministically apply managed project-manager label changes.
// Env: BODY_FILE, GITHUB_REPOSITORY, AGENT_PROJECT_MANAGEMENT_DRY_RUN,
//      AGENT_PROJECT_MANAGEMENT_APPLY_LABELS

import { readFileSync } from "node:fs";
import {
  applyManagedLabelChange,
  countManagedLabelOperations,
  ensureManagedLabels,
  parseManagedLabelPlan,
} from "../project-management-labels.js";
import { setOutput } from "../output.js";

function boolEnv(name: string, fallback = false): boolean {
  const value = (process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() || "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function appendStatus(summary: string, status: string): string {
  return `${summary.trim()}\n\n### Managed Label Application\n\n${status}\n`;
}

function main(): number {
  try {
    const bodyFile = requiredEnv("BODY_FILE");
    const repo = requiredEnv("GITHUB_REPOSITORY");
    const dryRun = boolEnv("AGENT_PROJECT_MANAGEMENT_DRY_RUN", true);
    const applyLabels = boolEnv("AGENT_PROJECT_MANAGEMENT_APPLY_LABELS", true);
    const summary = readFileSync(bodyFile, "utf8");
    const plan = parseManagedLabelPlan(summary);

    if (!plan.valid) {
      throw new Error("Project management summary did not include a valid fenced JSON label_changes plan.");
    }

    const operationCount = countManagedLabelOperations(plan.label_changes);

    if (dryRun || !applyLabels) {
      const status = dryRun
        ? `- Dry run is enabled; ${operationCount} managed label operation(s) were planned but not applied.`
        : `- Label application is disabled; ${operationCount} managed label operation(s) were planned but not applied.`;
      setOutput("labels_applied", "false");
      setOutput("operation_count", String(operationCount));
      setOutput("summary", appendStatus(summary, status));
      console.log(status);
      return 0;
    }

    if (operationCount > 0) {
      ensureManagedLabels(repo);
      for (const change of plan.label_changes) {
        applyManagedLabelChange(change, repo);
      }
    }

    const status = `- Applied ${operationCount} managed priority/effort label operation(s).`;
    setOutput("labels_applied", "true");
    setOutput("operation_count", String(operationCount));
    setOutput("summary", appendStatus(summary, status));
    console.log(status);
    return 0;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exitCode = main();
