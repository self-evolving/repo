import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  addDiscussionComment,
  createRepositoryDiscussion,
  fetchDiscussionComments,
  findRepositoryDiscussionByTitle,
} from "./discussion.js";
import type { GraphQLClient } from "./github-graphql.js";

export const DEFAULT_FAILURE_REPORT_REPOSITORY = "self-evolving/repo";
export const DEFAULT_FAILURE_REPORT_DISCUSSION_CATEGORY = "Bug Report";

const ERROR_TAIL_CHARS = 3000;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export type FailureReportStatus =
  | "skipped"
  | "created"
  | "commented"
  | "duplicate";

export interface AgentFailureReportInput {
  enabled: string;
  reportRepository: string;
  discussionCategory: string;
  sourceRepository: string;
  sourceRepositoryPrivate: boolean;
  route: string;
  workflow: string;
  targetKind: string;
  targetNumber: string;
  targetUrl: string;
  sourceKind: string;
  requestedBy: string;
  exitCode: string;
  runId: string;
  runAttempt: string;
  runUrl: string;
  serverUrl: string;
  sha: string;
  refName: string;
  errorSummary: string;
  seenAt: string;
}

export interface FailureReportResult {
  status: FailureReportStatus;
  reason: string;
  fingerprint: string;
  discussionUrl: string;
  commentUrl: string;
}

function trim(value: unknown): string {
  return String(value || "").trim();
}

function firstValue(values: string[], fallback: string): string {
  for (const value of values) {
    const normalized = trim(value);
    if (normalized) return normalized;
  }
  return fallback;
}

export function parseRepoSlug(
  slug: string,
  label = "repository",
): { owner: string; repo: string } {
  const [owner, repo, extra] = trim(slug).split("/");
  if (!owner || !repo || extra) {
    throw new Error(`${label} must be owner/repo (got: ${slug || "missing"})`);
  }
  return { owner, repo };
}

export function resolveFailureReportEnabled(
  raw: string,
  sourceRepositoryPrivate: boolean,
): { enabled: boolean; reason: string } {
  const value = trim(raw).toLowerCase() || "auto";
  if (value === "auto") {
    if (sourceRepositoryPrivate) {
      return {
        enabled: false,
        reason: "auto failure reporting is disabled for private repositories",
      };
    }
    return {
      enabled: true,
      reason: "auto failure reporting is enabled for public repositories",
    };
  }
  if (TRUE_VALUES.has(value)) {
    return { enabled: true, reason: "failure reporting is enabled" };
  }
  if (FALSE_VALUES.has(value)) {
    return { enabled: false, reason: "failure reporting is disabled" };
  }
  throw new Error(
    "AGENT_FAILURE_REPORT_ENABLED must be auto, true, or false",
  );
}

function isTruthyString(raw: string): boolean {
  return TRUE_VALUES.has(trim(raw).toLowerCase());
}

function buildRunUrl(env: NodeJS.ProcessEnv): string {
  const explicit = trim(env.GITHUB_RUN_URL);
  if (explicit) return explicit;

  const server = trim(env.GITHUB_SERVER_URL) || "https://github.com";
  const repo = trim(env.GITHUB_REPOSITORY);
  const runId = trim(env.GITHUB_RUN_ID);
  if (!repo || !runId) return "";
  return `${server}/${repo}/actions/runs/${runId}`;
}

function readTail(path: string): string {
  if (!path || !existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  return content.length > ERROR_TAIL_CHARS
    ? content.slice(content.length - ERROR_TAIL_CHARS)
    : content;
}

export function sanitizeFailureText(text: string): string {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted private key]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted github token]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted github token]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted api key]")
    .trim();
}

function buildErrorSummary(stdoutTail: string, stderrTail: string, exitCode: string): string {
  const parts: string[] = [];
  if (stderrTail.trim()) {
    parts.push(`stderr tail:\n${stderrTail.trim()}`);
  }
  if (stdoutTail.trim()) {
    parts.push(`stdout tail:\n${stdoutTail.trim()}`);
  }

  return sanitizeFailureText(
    parts.join("\n\n") ||
      `Agent process exited with code ${exitCode || "unknown"} before writing failure output.`,
  );
}

export function buildAgentFailureReportInput(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): AgentFailureReportInput {
  const sourceRepository = firstValue([
    env.SOURCE_REPOSITORY || "",
    env.GITHUB_REPOSITORY || "",
  ], "");
  if (!sourceRepository) {
    throw new Error("GITHUB_REPOSITORY is required for failure reporting");
  }
  parseRepoSlug(sourceRepository, "GITHUB_REPOSITORY");

  const stdoutTail = readTail(firstValue([
    env.AGENT_RAW_STDOUT_FILE || "",
    env.RAW_STDOUT_FILE || "",
  ], ""));
  const stderrTail = readTail(firstValue([
    env.AGENT_RAW_STDERR_FILE || "",
    env.RAW_STDERR_FILE || "",
  ], ""));
  const exitCode = firstValue([
    env.AGENT_EXIT_CODE || "",
    env.EXIT_CODE || "",
  ], "");

  return {
    enabled: firstValue([
      env.FAILURE_REPORT_ENABLED_INPUT || "",
      env.AGENT_FAILURE_REPORT_ENABLED || "",
    ], "auto"),
    reportRepository: firstValue([
      env.FAILURE_REPORT_REPOSITORY_INPUT || "",
      env.AGENT_FAILURE_REPORT_REPOSITORY || "",
    ], DEFAULT_FAILURE_REPORT_REPOSITORY),
    discussionCategory: firstValue([
      env.FAILURE_REPORT_DISCUSSION_CATEGORY_INPUT || "",
      env.AGENT_FAILURE_REPORT_DISCUSSION_CATEGORY || "",
    ], DEFAULT_FAILURE_REPORT_DISCUSSION_CATEGORY),
    sourceRepository,
    sourceRepositoryPrivate: isTruthyString(firstValue([
      env.SOURCE_REPOSITORY_PRIVATE || "",
      env.REPOSITORY_PRIVATE || "",
    ], "false")),
    route: firstValue([env.ROUTE || ""], "unknown"),
    workflow: firstValue([env.WORKFLOW || "", env.GITHUB_WORKFLOW || ""], "unknown"),
    targetKind: firstValue([env.TARGET_KIND || ""], "repository"),
    targetNumber: firstValue([env.TARGET_NUMBER || ""], "0"),
    targetUrl: trim(env.TARGET_URL || ""),
    sourceKind: trim(env.SOURCE_KIND || ""),
    requestedBy: trim(env.REQUESTED_BY || ""),
    exitCode,
    runId: trim(env.GITHUB_RUN_ID || ""),
    runAttempt: firstValue([env.GITHUB_RUN_ATTEMPT || ""], "1"),
    runUrl: buildRunUrl(env),
    serverUrl: trim(env.GITHUB_SERVER_URL || "") || "https://github.com",
    sha: trim(env.GITHUB_SHA || ""),
    refName: trim(env.GITHUB_REF_NAME || ""),
    errorSummary: buildErrorSummary(stdoutTail, stderrTail, exitCode),
    seenAt: now.toISOString(),
  };
}

function normalizeForFingerprint(value: string): string {
  return sanitizeFailureText(value)
    .toLowerCase()
    .replace(/[a-f0-9]{40}/g, "<sha>")
    .replace(/\b\d{6,}\b/g, "<num>")
    .replace(/\s+/g, " ")
    .slice(-1600);
}

export function buildFailureFingerprint(input: AgentFailureReportInput): string {
  const signature = [
    input.sourceRepository,
    input.workflow,
    input.route,
    input.targetKind,
    input.targetNumber,
    normalizeForFingerprint(input.errorSummary),
  ].join("\n");

  return createHash("sha256").update(signature).digest("hex");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

export function buildFailureDiscussionTitle(
  input: AgentFailureReportInput,
  fingerprint: string,
): string {
  const target =
    input.targetKind && input.targetKind !== "repository" && input.targetNumber !== "0"
      ? ` ${input.targetKind} #${input.targetNumber}`
      : "";
  return truncate(
    `[agent-failure:${fingerprint.slice(0, 12)}] ${input.sourceRepository} ${input.route}${target} failed`,
    200,
  );
}

function markerToken(value: string): string {
  return trim(value).replace(/[^A-Za-z0-9_.:-]/g, "_") || "unknown";
}

function occurrenceMarker(input: AgentFailureReportInput, fingerprint: string): string {
  return `<!-- sepo-agent-failure-occurrence fingerprint:${fingerprint} run_id:${markerToken(input.runId)} run_attempt:${markerToken(input.runAttempt)} -->`;
}

function reportMarker(input: AgentFailureReportInput, fingerprint: string): string {
  return `<!-- sepo-agent-failure-report fingerprint:${fingerprint} run_id:${markerToken(input.runId)} run_attempt:${markerToken(input.runAttempt)} -->`;
}

function tableValue(value: string): string {
  return trim(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function markdownLink(label: string, url: string): string {
  if (!url) return tableValue(label);
  return `[${tableValue(label)}](${url})`;
}

function targetLabel(input: AgentFailureReportInput): string {
  if (input.targetKind === "repository") return input.sourceRepository;
  if (input.targetNumber && input.targetNumber !== "0") {
    return `${input.targetKind} #${input.targetNumber}`;
  }
  return input.targetKind || "unknown";
}

function buildFields(input: AgentFailureReportInput, fingerprint: string): string {
  const runLabel = input.runId
    ? `run ${input.runId} attempt ${input.runAttempt || "1"}`
    : "workflow run";
  const rows = [
    ["Source repo", markdownLink(input.sourceRepository, `${input.serverUrl}/${input.sourceRepository}`)],
    ["Run", markdownLink(runLabel, input.runUrl)],
    ["Workflow", input.workflow],
    ["Route", input.route],
    ["Target", markdownLink(targetLabel(input), input.targetUrl)],
    ["Trigger", input.sourceKind || "unknown"],
    ["Requested by", input.requestedBy ? `@${input.requestedBy}` : "unknown"],
    ["Commit", input.sha ? `\`${input.sha.slice(0, 12)}\`` : "unknown"],
    ["Ref", input.refName || "unknown"],
    ["Exit code", input.exitCode || "unknown"],
    ["Fingerprint", `\`${fingerprint}\``],
    ["Seen at", input.seenAt],
  ];

  return [
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([field, value]) => `| ${field} | ${tableValue(value)} |`),
  ].join("\n");
}

function codeBlock(value: string): string {
  const text = trim(value).replace(/~~~/g, "~ ~ ~");
  return `~~~text\n${text || "No failure output was captured."}\n~~~`;
}

export function buildFailureDiscussionBody(
  input: AgentFailureReportInput,
  fingerprint: string,
): string {
  return [
    "## Agent Failure Report",
    "",
    "This discussion groups repeated agent failures with the same fingerprint. Promote it to an Issue when the report is actionable.",
    "",
    buildFields(input, fingerprint),
    "",
    "## Error Summary",
    "",
    codeBlock(input.errorSummary),
    "",
    reportMarker(input, fingerprint),
  ].join("\n");
}

export function buildFailureOccurrenceComment(
  input: AgentFailureReportInput,
  fingerprint: string,
): string {
  return [
    "## Repeat Occurrence",
    "",
    buildFields(input, fingerprint),
    "",
    "## Latest Error Summary",
    "",
    codeBlock(input.errorSummary),
    "",
    occurrenceMarker(input, fingerprint),
  ].join("\n");
}

function alreadyRecordedOccurrence(
  discussionBody: string,
  comments: Array<{ body: string }>,
  input: AgentFailureReportInput,
): boolean {
  const runNeedle = `run_id:${markerToken(input.runId)} run_attempt:${markerToken(input.runAttempt)}`;
  if (discussionBody.includes(runNeedle)) return true;
  return comments.some((comment) => comment.body.includes(runNeedle));
}

export function postAgentFailureReport(
  input: AgentFailureReportInput,
  client?: GraphQLClient,
): FailureReportResult {
  const enabled = resolveFailureReportEnabled(
    input.enabled,
    input.sourceRepositoryPrivate,
  );
  if (!enabled.enabled) {
    return {
      status: "skipped",
      reason: enabled.reason,
      fingerprint: "",
      discussionUrl: "",
      commentUrl: "",
    };
  }

  if (trim(input.exitCode) === "0") {
    return {
      status: "skipped",
      reason: "agent exit code was zero",
      fingerprint: "",
      discussionUrl: "",
      commentUrl: "",
    };
  }

  const { owner, repo } = parseRepoSlug(
    input.reportRepository,
    "AGENT_FAILURE_REPORT_REPOSITORY",
  );
  const category = trim(input.discussionCategory) ||
    DEFAULT_FAILURE_REPORT_DISCUSSION_CATEGORY;
  const fingerprint = buildFailureFingerprint(input);
  const title = buildFailureDiscussionTitle(input, fingerprint);
  const existing = findRepositoryDiscussionByTitle(
    owner,
    repo,
    title,
    category,
    client,
  );

  if (existing) {
    const comments = fetchDiscussionComments(owner, repo, existing.number, client);
    if (alreadyRecordedOccurrence(existing.body, comments, input)) {
      return {
        status: "duplicate",
        reason: "failure occurrence already recorded for this run attempt",
        fingerprint,
        discussionUrl: existing.url,
        commentUrl: "",
      };
    }

    const commentUrl = addDiscussionComment(
      existing.id,
      buildFailureOccurrenceComment(input, fingerprint),
      client,
    );
    return {
      status: "commented",
      reason: "posted repeat occurrence to existing failure discussion",
      fingerprint,
      discussionUrl: existing.url,
      commentUrl,
    };
  }

  const discussion = createRepositoryDiscussion(
    owner,
    repo,
    category,
    title,
    buildFailureDiscussionBody(input, fingerprint),
    client,
  );
  return {
    status: "created",
    reason: "created failure discussion",
    fingerprint,
    discussionUrl: discussion.url,
    commentUrl: "",
  };
}
