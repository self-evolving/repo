import { createHash } from "node:crypto";

import {
  addDiscussionComment,
  createRepositoryDiscussion,
  findRepositoryDiscussionByTitle,
} from "./discussion.js";
import type { GraphQLClient } from "./github-graphql.js";

export const FAILURE_REPORT_SCHEMA_VERSION = 1;

export type FailureReportMode = "false" | "diagnose" | "approval" | "true";

export type FailureCategory =
  | "setup_or_auth"
  | "provider_or_runtime"
  | "repo_policy_or_access"
  | "user_task_or_prompt"
  | "agent_product_bug_candidate"
  | "unknown";

export type FailureConfidence = "low" | "medium" | "high";
export type ProductBugLikelihood = "low" | "medium" | "high";

export interface FailureReportSource {
  repo: string;
  route: string;
  workflow: string;
  targetKind: string;
  targetNumber: string;
  targetUrl: string;
  sourceKind: string;
  requestedBy: string;
  runUrl: string;
  runId: string;
  runAttempt: string;
  sha: string;
}

export interface FailureReportInput {
  mode: FailureReportMode;
  exitCode: string;
  rawStdout: string;
  rawStderr: string;
  reportRepository: string;
  discussionCategory: string;
  source: FailureReportSource;
  now?: Date;
}

export interface ProposedDiscussion {
  repository: string;
  category: string;
  title: string;
  body: string;
  shouldPublish: boolean;
  publishable: boolean;
  warning: string;
}

export interface FailureDiagnosis {
  schemaVersion: number;
  mode: FailureReportMode;
  generatedAt: string;
  exitCode: string;
  fingerprint: string;
  headline: string;
  category: FailureCategory;
  confidence: FailureConfidence;
  productBugLikelihood: ProductBugLikelihood;
  reportable: boolean;
  suggestedNextAction: string;
  source: FailureReportSource;
  sanitizedEvidence: {
    stdoutTail: string;
    stderrTail: string;
  };
  proposedDiscussion: ProposedDiscussion;
  publication?: FailurePublication;
}

export interface FailurePublication {
  status: "created" | "commented" | "skipped" | "failed";
  url: string;
  reason: string;
}

export interface FailureReportRender {
  diagnosis: FailureDiagnosis;
  stepSummary: string;
  pendingReportBody: string;
}

const DEFAULT_REPORT_REPOSITORY = "self-evolving/repo";
const DEFAULT_DISCUSSION_CATEGORY = "Bug Report";
const MAX_EVIDENCE_CHARS = 6000;
const MAX_HEADLINE_CHARS = 120;

const CATEGORY_SUGGESTIONS: Record<FailureCategory, string> = {
  setup_or_auth:
    "Check repository secrets, GitHub App installation, token permissions, and provider credentials in the source repository.",
  provider_or_runtime:
    "Retry after provider or runner recovery; report centrally only if the same fingerprint repeats.",
  repo_policy_or_access:
    "Review AGENT_ACCESS_POLICY, route authorization, branch access, and workflow permissions.",
  user_task_or_prompt:
    "Clarify or narrow the user request, then retry from the original issue, PR, or discussion.",
  agent_product_bug_candidate:
    "Review the pending report and publish it to the central Bug Report Discussion if the sanitized evidence is safe.",
  unknown:
    "Inspect the workflow logs and keep this local unless the failure repeats or looks product-actionable.",
};

export function resolveFailureReportMode(
  rawMode: string | undefined,
  repositoryPrivate = false,
): FailureReportMode {
  const value = (rawMode || "").trim().toLowerCase();
  if (!value || value === "default" || value === "auto") {
    return repositoryPrivate ? "diagnose" : "approval";
  }

  if (["false", "0", "off", "no", "disabled"].includes(value)) return "false";
  if (value === "diagnose") return "diagnose";
  if (value === "approval") return "approval";
  if (["true", "1", "on", "yes", "enabled"].includes(value)) return "true";

  throw new Error(
    `Invalid AGENT_FAILURE_REPORT_MODE '${rawMode}'. Expected false, diagnose, approval, or true.`,
  );
}

export function sanitizeFailureEvidence(text: string): string {
  let result = text || "";
  result = result.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  );
  result = result.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  result = result.replace(/\bgh[opsru]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  result = result.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_PROVIDER_KEY]");
  result = result.replace(
    /\b((?:authorization|x-github-token)\s*:\s*(?:bearer|token)\s+)[^\s"'`]+/gi,
    "$1[REDACTED]",
  );
  result = result.replace(
    /\b((?:api[_-]?key|token|secret|password|private[_-]?key)\s*[:=]\s*)[^\s"'`]+/gi,
    "$1[REDACTED]",
  );
  return result;
}

export function classifyFailure(rawStdout: string, rawStderr: string): {
  category: FailureCategory;
  confidence: FailureConfidence;
  productBugLikelihood: ProductBugLikelihood;
} {
  const evidence = sanitizeFailureEvidence(`${rawStderr}\n${rawStdout}`).toLowerCase();
  const hasAgentStackEvidence = matchesAny(evidence, [
    /\.agent\/dist\//,
    /\.agent\/src\//,
    /\bat .+\(.+\.agent\//,
  ]);

  if (matchesAny(evidence, [
    /agent_access_policy/,
    /access policy/,
    /policy denied/,
    /not permitted/,
    /not allowed/,
    /author_association/,
    /route .*denied/,
    /requires approval/,
  ])) {
    return {
      category: "repo_policy_or_access",
      confidence: "high",
      productBugLikelihood: "low",
    };
  }

  if (matchesAny(evidence, [
    /bad credentials/,
    /resource not accessible by integration/,
    /requires authentication/,
    /authentication failed/,
    /permission denied/,
    /\b401\b/,
    /\b403\b/,
    /not authorized/,
    /could not read username/,
    /missing .*token/,
    /missing .*key/,
    /invalid .*token/,
    /invalid .*key/,
  ])) {
    return {
      category: "setup_or_auth",
      confidence: "high",
      productBugLikelihood: "low",
    };
  }

  if (
    hasAgentStackEvidence ||
    matchesAny(evidence, [
      /unhandledpromiserejection/,
      /cannot find module/,
      /err_module_not_found/,
    ])
  ) {
    return {
      category: "agent_product_bug_candidate",
      confidence: "high",
      productBugLikelihood: "high",
    };
  }

  if (matchesAny(evidence, [
    /rate limit/,
    /\b429\b/,
    /quota/,
    /overloaded/,
    /temporarily unavailable/,
    /timed out/,
    /timeout/,
    /etimedout/,
    /econnreset/,
    /network/,
    /openai/,
    /anthropic/,
    /provider/,
    /\bacpx\b/,
    /npm err/,
  ])) {
    return {
      category: "provider_or_runtime",
      confidence: "medium",
      productBugLikelihood: "low",
    };
  }

  if (matchesAny(evidence, [
    /no changes/,
    /nothing to commit/,
    /invalid json/,
    /expected .*json/,
    /unable to produce a response/,
    /clarification/,
    /ambiguous request/,
    /user request/,
    /prompt/,
  ])) {
    return {
      category: "user_task_or_prompt",
      confidence: "medium",
      productBugLikelihood: "low",
    };
  }

  return {
    category: "unknown",
    confidence: "low",
    productBugLikelihood: "low",
  };
}

export function buildFailureReport(input: FailureReportInput): FailureReportRender {
  const stdoutTail = truncateTail(sanitizeFailureEvidence(input.rawStdout), MAX_EVIDENCE_CHARS);
  const stderrTail = truncateTail(sanitizeFailureEvidence(input.rawStderr), MAX_EVIDENCE_CHARS);
  const classification = classifyFailure(input.rawStdout, input.rawStderr);
  const headline = buildHeadline(stderrTail, stdoutTail);
  const fingerprint = buildFailureFingerprint({
    route: input.source.route,
    exitCode: input.exitCode,
    category: classification.category,
    evidence: `${stderrTail}\n${stdoutTail}`,
  });
  const reportable =
    classification.category === "agent_product_bug_candidate" &&
    classification.confidence === "high" &&
    classification.productBugLikelihood === "high";

  const generatedAt = (input.now || new Date()).toISOString();
  const proposedDiscussion = buildProposedDiscussion({
    category: classification.category,
    confidence: classification.confidence,
    discussionCategory: input.discussionCategory || DEFAULT_DISCUSSION_CATEGORY,
    exitCode: input.exitCode,
    fingerprint,
    headline,
    productBugLikelihood: classification.productBugLikelihood,
    reportRepository: input.reportRepository || DEFAULT_REPORT_REPOSITORY,
    reportable,
    source: input.source,
    stderrTail,
    stdoutTail,
    suggestedNextAction: CATEGORY_SUGGESTIONS[classification.category],
  });

  const diagnosis: FailureDiagnosis = {
    schemaVersion: FAILURE_REPORT_SCHEMA_VERSION,
    mode: input.mode,
    generatedAt,
    exitCode: input.exitCode,
    fingerprint,
    headline,
    category: classification.category,
    confidence: classification.confidence,
    productBugLikelihood: classification.productBugLikelihood,
    reportable,
    suggestedNextAction: CATEGORY_SUGGESTIONS[classification.category],
    source: input.source,
    sanitizedEvidence: {
      stdoutTail,
      stderrTail,
    },
    proposedDiscussion,
  };

  return {
    diagnosis,
    stepSummary: buildStepSummary(diagnosis),
    pendingReportBody: proposedDiscussion.body,
  };
}

export function publishFailureReport(
  diagnosis: FailureDiagnosis,
  client?: GraphQLClient,
): FailurePublication {
  if (diagnosis.mode !== "true") {
    return { status: "skipped", url: "", reason: `mode ${diagnosis.mode} does not publish` };
  }
  if (diagnosis.proposedDiscussion.publishable === false) {
    return {
      status: "skipped",
      url: "",
      reason: diagnosis.proposedDiscussion.warning || "pending Discussion destination is not publishable",
    };
  }
  if (!diagnosis.proposedDiscussion.shouldPublish) {
    return {
      status: "skipped",
      url: "",
      reason: `category ${diagnosis.category} is not policy-qualified for auto-publish`,
    };
  }

  return publishFailureReportToDiscussion(diagnosis, client);
}

export function publishApprovedFailureReport(
  diagnosis: FailureDiagnosis,
  client?: GraphQLClient,
): FailurePublication {
  if (diagnosis.mode !== "approval") {
    return {
      status: "skipped",
      url: "",
      reason: `mode ${diagnosis.mode} is not pending approval`,
    };
  }
  if (diagnosis.proposedDiscussion.publishable === false) {
    return {
      status: "skipped",
      url: "",
      reason: diagnosis.proposedDiscussion.warning || "pending Discussion destination is not publishable",
    };
  }
  return publishFailureReportToDiscussion(diagnosis, client);
}

function publishFailureReportToDiscussion(
  diagnosis: FailureDiagnosis,
  client?: GraphQLClient,
): FailurePublication {
  const { owner, repo } = parseRepoSlug(diagnosis.proposedDiscussion.repository);
  const existing = findRepositoryDiscussionByTitle(
    owner,
    repo,
    diagnosis.proposedDiscussion.title,
    diagnosis.proposedDiscussion.category,
    client,
  );
  if (existing) {
    const url = addDiscussionComment(
      existing.id,
      buildRepeatOccurrenceBody(diagnosis),
      client,
    );
    return { status: "commented", url, reason: "matched existing failure fingerprint" };
  }

  const created = createRepositoryDiscussion(
    owner,
    repo,
    diagnosis.proposedDiscussion.category,
    diagnosis.proposedDiscussion.title,
    diagnosis.proposedDiscussion.body,
    client,
  );
  return { status: "created", url: created.url, reason: "created failure report discussion" };
}

export interface FailureReportDestinationValidation {
  repository: string;
  category: string;
  publishable: boolean;
  warning: string;
}

export function validateFailureReportDestination(
  reportRepository: string,
  discussionCategory: string,
): FailureReportDestinationValidation {
  const repository = String(reportRepository || "").trim() || DEFAULT_REPORT_REPOSITORY;
  const category = String(discussionCategory || "").trim() || DEFAULT_DISCUSSION_CATEGORY;
  let warning = "";

  try {
    parseRepoSlug(repository);
  } catch (err: unknown) {
    warning = err instanceof Error ? err.message : String(err);
  }

  if (!warning && !category.trim()) {
    warning = "failure report discussion category must be non-empty";
  }

  return {
    repository,
    category,
    publishable: !warning,
    warning,
  };
}

function buildProposedDiscussion(args: {
  reportRepository: string;
  discussionCategory: string;
  source: FailureReportSource;
  exitCode: string;
  category: FailureCategory;
  confidence: FailureConfidence;
  productBugLikelihood: ProductBugLikelihood;
  reportable: boolean;
  fingerprint: string;
  headline: string;
  suggestedNextAction: string;
  stdoutTail: string;
  stderrTail: string;
}): ProposedDiscussion {
  const destination = validateFailureReportDestination(
    args.reportRepository,
    args.discussionCategory,
  );
  const title = `[agent-failure] ${args.source.route} failed: ${shortText(args.headline, 72)} (${args.fingerprint.slice(0, 12)})`;
  const body = [
    `<!-- sepo-agent-failure-report fingerprint:${args.fingerprint} run:${args.source.runId} -->`,
    "",
    "## Summary",
    "",
    `Sepo diagnosed a failed agent run as \`${args.category}\` with \`${args.confidence}\` confidence.`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Product bug likelihood | ${args.productBugLikelihood} |`,
    `| Auto-report policy | ${args.reportable ? "eligible" : "not eligible"} |`,
    `| Publication status | ${destination.publishable ? "publishable" : `unpublishable preview: ${escapeTableCell(destination.warning)}`} |`,
    `| Suggested next action | ${escapeTableCell(args.suggestedNextAction)} |`,
    `| Fingerprint | \`${args.fingerprint}\` |`,
    "",
    "## Source",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Repository | \`${escapeTableCell(args.source.repo)}\` |`,
    `| Workflow | \`${escapeTableCell(args.source.workflow)}\` |`,
    `| Route | \`${escapeTableCell(args.source.route)}\` |`,
    `| Target | ${escapeTableCell(formatTarget(args.source))} |`,
    `| Requested by | \`${escapeTableCell(args.source.requestedBy || "unknown")}\` |`,
    `| Exit code | \`${escapeTableCell(args.exitCode)}\` |`,
    `| Run | ${args.source.runUrl || "unknown"} |`,
    `| SHA | \`${escapeTableCell(args.source.sha || "unknown")}\` |`,
    "",
    "## Sanitized Evidence",
    "",
    "### stderr",
    "",
    fencedBlock(args.stderrTail || "No stderr captured."),
    "",
    "### stdout",
    "",
    fencedBlock(args.stdoutTail || "No stdout captured."),
  ].join("\n");

  return {
    repository: destination.repository,
    category: destination.category,
    title,
    body,
    shouldPublish: args.reportable && destination.publishable,
    publishable: destination.publishable,
    warning: destination.warning,
  };
}

function buildStepSummary(diagnosis: FailureDiagnosis): string {
  const pendingNote =
    diagnosis.mode === "approval"
      ? "Pending central-report draft saved as an artifact for human review."
      : diagnosis.mode === "true"
        ? diagnosis.reportable
          ? "Auto-publish is enabled and this fingerprint is policy-qualified."
          : "Auto-publish is enabled, but this fingerprint is not policy-qualified."
        : "Local diagnosis only.";
  const warningNote = diagnosis.proposedDiscussion.publishable === false
    ? `\n\nWarning: pending report is not publishable: ${diagnosis.proposedDiscussion.warning}`
    : "";

  return [
    "## Agent Failure Diagnosis",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Mode | \`${diagnosis.mode}\` |`,
    `| Category | \`${diagnosis.category}\` |`,
    `| Confidence | \`${diagnosis.confidence}\` |`,
    `| Product bug likelihood | \`${diagnosis.productBugLikelihood}\` |`,
    `| Fingerprint | \`${diagnosis.fingerprint}\` |`,
    `| Suggested next action | ${escapeTableCell(diagnosis.suggestedNextAction)} |`,
    "",
    `${pendingNote}${warningNote}`,
  ].join("\n");
}

function buildRepeatOccurrenceBody(diagnosis: FailureDiagnosis): string {
  return [
    `<!-- sepo-agent-failure-report-occurrence fingerprint:${diagnosis.fingerprint} run:${diagnosis.source.runId} -->`,
    "",
    "## Repeat Occurrence",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Repository | \`${escapeTableCell(diagnosis.source.repo)}\` |`,
    `| Workflow | \`${escapeTableCell(diagnosis.source.workflow)}\` |`,
    `| Route | \`${escapeTableCell(diagnosis.source.route)}\` |`,
    `| Target | ${escapeTableCell(formatTarget(diagnosis.source))} |`,
    `| Exit code | \`${escapeTableCell(diagnosis.exitCode)}\` |`,
    `| Run | ${diagnosis.source.runUrl || "unknown"} |`,
    `| SHA | \`${escapeTableCell(diagnosis.source.sha || "unknown")}\` |`,
    "",
    "### Sanitized stderr",
    "",
    fencedBlock(diagnosis.sanitizedEvidence.stderrTail || "No stderr captured."),
  ].join("\n");
}

function buildFailureFingerprint(args: {
  route: string;
  exitCode: string;
  category: FailureCategory;
  evidence: string;
}): string {
  const normalizedEvidence = args.evidence
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/g, "<timestamp>")
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ")
    .slice(0, 2400);
  return createHash("sha256")
    .update(`${args.route}\n${args.exitCode}\n${args.category}\n${normalizedEvidence}`)
    .digest("hex")
    .slice(0, 24);
}

function buildHeadline(stderrTail: string, stdoutTail: string): string {
  const combined = `${stderrTail}\n${stdoutTail}`;
  for (const line of combined.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\{.*"ts":/.test(trimmed)) continue;
    return shortText(trimmed.replace(/\s+/g, " "), MAX_HEADLINE_CHARS);
  }
  return "agent run failed";
}

function truncateTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `[...truncated...]\n${value.slice(value.length - maxChars)}`;
}

function fencedBlock(value: string): string {
  const fence = value.includes("```") ? "~~~" : "```";
  return `${fence}\n${value}\n${fence}`;
}

function shortText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatTarget(source: FailureReportSource): string {
  if (!source.targetKind || !source.targetNumber || source.targetNumber === "0") {
    return source.targetUrl || "repository";
  }
  return `${source.targetKind} #${source.targetNumber}${source.targetUrl ? ` (${source.targetUrl})` : ""}`;
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const [owner, repo, extra] = String(slug || "").trim().split("/");
  const validPart = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !repo || extra || !validPart.test(owner) || !validPart.test(repo)) {
    throw new Error(`failure report repository must be owner/repo (got: ${slug || "missing"})`);
  }
  return { owner, repo };
}
