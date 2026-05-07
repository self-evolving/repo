#!/usr/bin/env node
// CLI: publish a human-approved pending agent failure report.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  FAILURE_REPORT_SCHEMA_VERSION,
  publishApprovedFailureReport,
  type FailureDiagnosis,
  type FailurePublication,
} from "../failure-report.js";
import {
  getAllowedAssociationsForRoute,
  isAssociationAllowedForRoute,
  parseAccessPolicy,
} from "../access-policy.js";
import { gh, ghApi, ghApiOk } from "../github.js";
import { setOutput } from "../output.js";

const ROUTE = "publish-failure-report";

interface RequestArgs {
  runId: string;
  runAttempt: string;
  artifactName: string;
  fingerprint: string;
}

function env(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

function appendStepSummary(summary: string): void {
  const summaryPath = env("GITHUB_STEP_SUMMARY");
  if (!summaryPath) return;
  appendFileSync(summaryPath, `${summary.trim()}\n`, "utf8");
}

function tableValue(value: string): string {
  return (value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function parseRequestArgs(text: string): RequestArgs {
  const body = String(text || "");
  const routeTail = body.split(/\/publish-failure-report\b/i).slice(1).join(" ") || body;
  const runId = readArg(body, ["run_id", "run-id", "run"]) ||
    routeTail.match(/\b\d{5,}\b/)?.[0] || "";
  const runAttempt = readArg(body, ["run_attempt", "run-attempt", "attempt"]) || "";
  const artifactName = readArg(body, ["artifact_name", "artifact-name", "artifact"]) || "";
  const fingerprint = readArg(body, ["fingerprint", "fp"]) || "";

  return { runId, runAttempt, artifactName, fingerprint };
}

function readArg(text: string, keys: string[]): string {
  const keyPattern = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = String(text || "").match(
    new RegExp(`(?:^|[\\s,;])(?:${keyPattern})(?:\\s*[:=]\\s*|\\s+)([^\\s,;]+)`, "i"),
  );
  return match?.[1]?.trim() || "";
}

function resolveRequesterAssociation(requester: string): string {
  const login = requester.trim();
  const repository = env("GITHUB_REPOSITORY");
  if (!login || !repository) return "NONE";

  const [owner] = repository.split("/");
  const ownerType = ghApi([`repos/${repository}`, "--jq", ".owner.type // empty"]).toLowerCase();
  if (ownerType === "user" && owner.toLowerCase() === login.toLowerCase()) {
    return "OWNER";
  }

  if (ownerType === "organization" && owner) {
    const membershipState = ghApi([
      `orgs/${owner}/memberships/${login}`,
      "--jq",
      ".state // empty",
    ]).toLowerCase();
    if (membershipState === "active" || ghApiOk([`orgs/${owner}/members/${login}`])) {
      return "MEMBER";
    }
  }

  const permission = ghApi([
    `repos/${repository}/collaborators/${login}/permission`,
    "--jq",
    ".permission // .role_name // empty",
  ]).toLowerCase();
  if (permission && permission !== "none") {
    return "COLLABORATOR";
  }

  return "NONE";
}

function assertRequesterAuthorized(requester: string, associationInput: string): string {
  const policy = parseAccessPolicy(env("ACCESS_POLICY"));
  const isPublicRepo = env("REPOSITORY_PRIVATE").trim().toLowerCase() === "false";
  const association = (associationInput || resolveRequesterAssociation(requester)).trim().toUpperCase();
  if (isAssociationAllowedForRoute(policy, ROUTE, association, isPublicRepo)) {
    return association;
  }

  const allowed = getAllowedAssociationsForRoute(policy, ROUTE, isPublicRepo);
  throw new Error(
    `${ROUTE} requests currently require ${allowed.join(", ")} access; ${requester || "unknown"} resolved as ${association || "NONE"}.`,
  );
}

function downloadDiagnosisFile(args: RequestArgs): string {
  const repository = env("GITHUB_REPOSITORY");
  if (!repository) throw new Error("Missing GITHUB_REPOSITORY");
  if (!args.runId) {
    throw new Error(
      "Missing failure report run_id. Use /publish-failure-report run_id=<actions_run_id> or the workflow input.",
    );
  }

  const artifactName = args.artifactName ||
    `agent-failure-diagnosis-${args.runId}-${args.runAttempt || "1"}`;
  const downloadDir = env(
    "FAILURE_REPORT_DOWNLOAD_DIR",
    join(env("RUNNER_TEMP", "/tmp"), `approved-failure-report-${args.runId}`),
  );
  mkdirSync(downloadDir, { recursive: true });

  gh([
    "run",
    "download",
    args.runId,
    "--repo",
    repository,
    "--name",
    artifactName,
    "--dir",
    downloadDir,
  ]);

  const diagnosisFile = findFile(downloadDir, "diagnosis.json");
  if (!diagnosisFile) {
    throw new Error(`Downloaded artifact ${artifactName} did not contain diagnosis.json`);
  }
  return diagnosisFile;
}

function findFile(root: string, fileName: string): string {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const found = findFile(fullPath, fileName);
      if (found) return found;
    }
  }
  return "";
}

function readDiagnosis(path: string, expectedFingerprint: string): FailureDiagnosis {
  if (!path || !existsSync(path)) {
    throw new Error(`Failure diagnosis file not found: ${path || "missing"}`);
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FailureDiagnosis>;
  if (parsed.schemaVersion !== FAILURE_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported failure diagnosis schema version: ${parsed.schemaVersion || "missing"}`,
    );
  }
  if (parsed.mode !== "approval") {
    throw new Error(`Failure diagnosis mode must be approval, got ${parsed.mode || "missing"}`);
  }
  if (!parsed.fingerprint || !parsed.proposedDiscussion) {
    throw new Error("Failure diagnosis is missing fingerprint or proposedDiscussion");
  }
  if (expectedFingerprint && parsed.fingerprint !== expectedFingerprint) {
    throw new Error(
      `Failure diagnosis fingerprint ${parsed.fingerprint} does not match requested ${expectedFingerprint}`,
    );
  }

  return parsed as FailureDiagnosis;
}

function emitPublication(publication: FailurePublication, diagnosis: FailureDiagnosis): void {
  setOutput("failure_report_publish_status", publication.status);
  setOutput("failure_report_discussion_url", publication.url);
  setOutput("failure_report_publish_reason", publication.reason);
  setOutput("failure_report_fingerprint", diagnosis.fingerprint);
  writePublicationResponse(publication, diagnosis.fingerprint);
  appendStepSummary([
    "## Approved Failure Report Publication",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Status | \`${publication.status}\` |`,
    `| Fingerprint | \`${diagnosis.fingerprint}\` |`,
    `| Reason | ${publication.reason} |`,
    `| Discussion | ${publication.url || "not published"} |`,
  ].join("\n"));
}

function writePublicationResponse(publication: FailurePublication, fingerprint: string): void {
  const responseFile = env(
    "FAILURE_REPORT_RESPONSE_FILE",
    join(env("RUNNER_TEMP", "/tmp"), "failure-report-publication.md"),
  );
  const body = [
    `<!-- sepo-agent-failure-report-publish status:${publication.status} fingerprint:${fingerprint || "unknown"} -->`,
    "",
    `Failure report publication \`${publication.status}\`.`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Fingerprint | \`${tableValue(fingerprint || "unknown")}\` |`,
    `| Discussion | ${tableValue(publication.url || "not published")} |`,
    `| Reason | ${tableValue(publication.reason)} |`,
  ].join("\n");

  writeFileSync(responseFile, `${body}\n`, "utf8");
  setOutput("failure_report_response_file", responseFile);
}

function usePublishTokenIfConfigured(): void {
  const token = env("FAILURE_REPORT_PUBLISH_TOKEN");
  if (!token) return;
  process.env.GH_TOKEN = token;
  process.env.GITHUB_TOKEN = token;
}

function main(): number {
  try {
    const requestArgs = parseRequestArgs(env("REQUEST_TEXT"));
    requestArgs.runId = env("FAILURE_REPORT_RUN_ID", requestArgs.runId);
    requestArgs.runAttempt = env("FAILURE_REPORT_RUN_ATTEMPT", requestArgs.runAttempt);
    requestArgs.artifactName = env("FAILURE_REPORT_ARTIFACT_NAME", requestArgs.artifactName);
    requestArgs.fingerprint = env("FAILURE_REPORT_FINGERPRINT", requestArgs.fingerprint);

    const requester = env("REQUESTED_BY", env("GITHUB_ACTOR"));
    const association = assertRequesterAuthorized(requester, env("REQUESTER_ASSOCIATION"));
    const diagnosisFile = env("FAILURE_REPORT_DIAGNOSIS_FILE") ||
      downloadDiagnosisFile(requestArgs);
    const diagnosis = readDiagnosis(diagnosisFile, requestArgs.fingerprint);
    usePublishTokenIfConfigured();
    const publication = publishApprovedFailureReport(diagnosis);

    setOutput("failure_report_diagnosis_file", diagnosisFile);
    setOutput("failure_report_requester_association", association);
    emitPublication(publication, diagnosis);

    console.log(
      `Approved failure report publication ${publication.status}: ${publication.reason}`,
    );
    return publication.status === "created" || publication.status === "commented" ? 0 : 1;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    setOutput("failure_report_publish_status", "failed");
    setOutput("failure_report_publish_reason", reason);
    writePublicationResponse(
      { status: "failed", url: "", reason },
      env("FAILURE_REPORT_FINGERPRINT") || "unknown",
    );
    appendStepSummary([
      "## Approved Failure Report Publication",
      "",
      `Failed: ${reason}`,
    ].join("\n"));
    console.error(reason);
    return 1;
  }
}

process.exitCode = main();
