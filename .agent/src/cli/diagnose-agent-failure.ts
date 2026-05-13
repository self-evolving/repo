#!/usr/bin/env node
// CLI: diagnose a failed agent run and prepare local failure-report artifacts.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  buildFailureReport,
  publishFailureReport,
  resolveFailureReportMode,
  type FailurePublication,
  type FailureReportSource,
} from "../failure-report.js";
import { setOutput } from "../output.js";

function env(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

function boolEnv(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(env(name).trim().toLowerCase());
}

function readOptionalFile(path: string): string {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function currentRunUrl(): string {
  const server = env("GITHUB_SERVER_URL");
  const repo = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  if (!server || !repo || !runId) return "";
  return `${server}/${repo}/actions/runs/${runId}`;
}

function safeArtifactPart(value: string): string {
  return (value || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function buildSource(): FailureReportSource {
  return {
    repo: env("GITHUB_REPOSITORY", env("REPO_SLUG")),
    route: env("ROUTE"),
    workflow: env("WORKFLOW", env("GITHUB_WORKFLOW")),
    targetKind: env("TARGET_KIND"),
    targetNumber: env("TARGET_NUMBER"),
    targetUrl: env("TARGET_URL"),
    sourceKind: env("SOURCE_KIND"),
    requestedBy: env("REQUESTED_BY", env("GITHUB_ACTOR")),
    runUrl: env("GITHUB_RUN_URL", currentRunUrl()),
    runId: env("GITHUB_RUN_ID"),
    runAttempt: env("GITHUB_RUN_ATTEMPT"),
    sha: env("GITHUB_SHA"),
  };
}

function appendStepSummary(summary: string): void {
  const summaryPath = env("GITHUB_STEP_SUMMARY");
  if (!summaryPath) return;
  appendFileSync(summaryPath, `${summary.trim()}\n`, "utf8");
}

function main(): number {
  try {
    const mode = resolveFailureReportMode(
      env("AGENT_FAILURE_REPORT_MODE"),
      boolEnv("REPOSITORY_PRIVATE"),
    );
    setOutput("failure_report_mode", mode);

    if (mode === "false") {
      setOutput("failure_report_status", "disabled");
      return 0;
    }

    const source = buildSource();
    const rawStdout = readOptionalFile(env("RAW_STDOUT_FILE"));
    const rawStderr = readOptionalFile(env("RAW_STDERR_FILE"));
    const report = buildFailureReport({
      mode,
      exitCode: env("AGENT_EXIT_CODE", "unknown"),
      rawStdout,
      rawStderr,
      reportRepository: env("FAILURE_REPORT_REPOSITORY", "self-evolving/repo"),
      discussionCategory: env("FAILURE_REPORT_DISCUSSION_CATEGORY", "Bug Report"),
      source,
    });

    let status =
      mode === "diagnose"
        ? "diagnosed"
        : mode === "approval"
          ? "pending_approval"
          : "auto_skipped";
    let discussionUrl = "";
    let publication: FailurePublication | undefined;
    if (mode === "true") {
      try {
        publication = publishFailureReport(report.diagnosis);
        status = publication.status === "skipped" ? "auto_skipped" : `auto_${publication.status}`;
        discussionUrl = publication.url;
        report.diagnosis.publication = publication;
      } catch (err: unknown) {
        publication = {
          status: "failed",
          url: "",
          reason: err instanceof Error ? err.message : String(err),
        };
        status = "publish_failed";
        report.diagnosis.publication = publication;
        console.warn(`Failure report publication failed: ${publication.reason}`);
      }
    }

    const runId = safeArtifactPart(source.runId || Date.now().toString());
    const runAttempt = safeArtifactPart(source.runAttempt || "1");
    const artifactName = `agent-failure-diagnosis-${runId}-${runAttempt}`;
    const artifactDir = join(env("RUNNER_TEMP", "/tmp"), artifactName);
    mkdirSync(artifactDir, { recursive: true });

    const diagnosisFile = join(artifactDir, "diagnosis.json");
    const pendingBodyFile = join(artifactDir, "pending-report.md");
    writeFileSync(diagnosisFile, `${JSON.stringify(report.diagnosis, null, 2)}\n`, "utf8");
    if (mode === "approval" || mode === "true") {
      writeFileSync(pendingBodyFile, `${report.pendingReportBody.trim()}\n`, "utf8");
    }

    appendStepSummary(report.stepSummary);
    setOutput("failure_report_status", status);
    setOutput("failure_report_category", report.diagnosis.category);
    setOutput("failure_report_fingerprint", report.diagnosis.fingerprint);
    setOutput("failure_report_diagnosis_file", diagnosisFile);
    setOutput(
      "failure_report_pending_body_file",
      mode === "approval" || mode === "true" ? pendingBodyFile : "",
    );
    setOutput("failure_report_artifact_dir", artifactDir);
    setOutput("failure_report_artifact_name", artifactName);
    setOutput("failure_report_discussion_url", discussionUrl);

    console.log(
      `Failure diagnosis ${status}: ${report.diagnosis.category} (${report.diagnosis.fingerprint})`,
    );
    return 0;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exitCode = main();
