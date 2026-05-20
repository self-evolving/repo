#!/usr/bin/env node
// CLI: validate and optionally apply an agent-produced repository variable plan.
// Env: BODY_FILE, GITHUB_REPOSITORY, AGENT_CONFIG_APPLY, SUMMARY_FILE
// Outputs: applied, operation_count, body_file

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyRepoConfigPlan,
  countRepoConfigOperations,
  formatRepoConfigError,
  formatRepoConfigSummary,
  parseRepoConfigPlan,
} from "../repo-config.js";
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

function resolveSummaryFile(): string {
  const configured = process.env.SUMMARY_FILE?.trim();
  if (configured) return configured;
  const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
  return join(runnerTemp, `repo-config-summary-${randomBytes(8).toString("hex")}.md`);
}

function writeSummary(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  setOutput("body_file", path);
}

function main(): number {
  const summaryFile = resolveSummaryFile();

  try {
    const bodyFile = requiredEnv("BODY_FILE");
    const repo = requiredEnv("GITHUB_REPOSITORY");
    const apply = boolEnv("AGENT_CONFIG_APPLY", false);
    const raw = readFileSync(bodyFile, "utf8");
    const plan = parseRepoConfigPlan(raw);
    const operationCount = countRepoConfigOperations(plan);
    const results = apply ? applyRepoConfigPlan(repo, plan) : [];
    const summary = formatRepoConfigSummary({ repo, apply, plan, results });

    writeSummary(summaryFile, summary);
    setOutput("applied", apply ? "true" : "false");
    setOutput("operation_count", String(operationCount));
    console.log(
      apply
        ? `Applied ${operationCount} repository variable operation(s).`
        : `Validated ${operationCount} repository variable operation(s) in dry-run mode.`,
    );
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    writeSummary(summaryFile, formatRepoConfigError(message));
    setOutput("applied", "false");
    setOutput("operation_count", "0");
    console.error(message);
    return 1;
  }
}

process.exitCode = main();
