import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { extractJsonObject } from "./response.js";

export const SELF_IMPROVEMENT_PROPOSAL_MARKER =
  "<!-- sepo-agent-self-improvement-proposal -->";
export const SELF_IMPROVEMENT_DECISION_MARKER =
  "<!-- sepo-agent-self-improvement-decision -->";

export type SelfImprovementDecisionKind = "new_issue" | "continue_issue" | "continue_pr";

export interface SelfImprovementDecision {
  decision: SelfImprovementDecisionKind;
  reason: string;
  issueTitle: string;
  issueBody: string;
  targetNumber: number | null;
  comment: string;
}

export interface SelfImprovementRunContext {
  repo: string;
  runId?: string;
  runUrl?: string;
  eventName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeWhitespace(value: string): string {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeSelfImprovementDecisionKind(value: string): SelfImprovementDecisionKind | null {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "new_issue" || normalized === "create_issue") return "new_issue";
  if (normalized === "continue_issue" || normalized === "existing_issue") return "continue_issue";
  if (
    normalized === "continue_pr" ||
    normalized === "continue_pull_request" ||
    normalized === "existing_pr" ||
    normalized === "existing_pull_request"
  ) {
    return "continue_pr";
  }
  return null;
}

function stringField(record: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function positiveIntegerField(record: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = record[name];
    const number = typeof value === "number" ? value : Number(String(value || ""));
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function parseDecisionPayload(raw: string): Record<string, unknown> | null {
  const json = extractJsonObject(raw);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Self-improvement planner response contains invalid JSON: ${message}`);
  }

  const record = asRecord(parsed);
  if (!record) {
    throw new Error("Self-improvement planner response JSON must be an object.");
  }
  return record;
}

export function parseSelfImprovementDecision(raw: string): SelfImprovementDecision {
  const payload = parseDecisionPayload(raw);
  if (!payload) {
    throw new Error("Self-improvement planner response must contain a JSON object decision.");
  }
  const decision = normalizeSelfImprovementDecisionKind(stringField(payload, "decision", "action"));
  if (!decision) {
    throw new Error("Self-improvement decision must be one of: new_issue, continue_issue, continue_pr.");
  }

  const reason = stringField(payload, "reason", "rationale");
  if (!reason) {
    throw new Error("Self-improvement decision must include a non-empty reason.");
  }

  const targetNumber = positiveIntegerField(payload, "target_number", "target", "number", "pr_number", "issue_number");
  const issueTitle = normalizeWhitespace(stringField(payload, "issue_title", "title"));
  const issueBody = stringField(payload, "issue_body", "body", "proposal_body");
  const comment = stringField(payload, "comment", "trace_comment", "continuation_comment", "user_message");

  if (decision === "new_issue") {
    if (!issueTitle) {
      throw new Error("new_issue decisions must include issue_title.");
    }
    if (!issueBody) {
      throw new Error("new_issue decisions must include issue_body.");
    }
  } else if (!targetNumber) {
    throw new Error(`${decision} decisions must include a positive target_number.`);
  }

  return {
    decision,
    reason,
    issueTitle,
    issueBody,
    targetNumber,
    comment,
  };
}

export function normalizeIssueTitle(raw: string): string {
  const title = normalizeWhitespace(raw);
  if (!title) return "Self-improvement proposal";
  return title.length <= 70 ? title : `${title.slice(0, 67).trimEnd()}...`;
}

export function selfImprovementRunMarker(runId: string | undefined): string {
  const normalized = String(runId || "").trim();
  return normalized ? `<!-- sepo-agent-self-improvement-run:${normalized} -->` : "";
}

function insertMarkersAfterH1(markdown: string, markers: string[]): string {
  const body = String(markdown || "").trim();
  if (!body) return markers.join("\n");

  const missing = markers.filter((marker) => marker && !body.includes(marker));
  if (!missing.length) return `${body}\n`;

  const lines = body.split(/\r?\n/);
  const h1Index = lines.findIndex((line) => /^\s*#\s+/.test(line));
  if (h1Index >= 0) {
    lines.splice(h1Index + 1, 0, "", ...missing);
    return `${lines.join("\n").trim()}\n`;
  }
  return `${missing.join("\n")}\n\n${body}\n`;
}

export function buildSelfImprovementIssueBody(
  decision: SelfImprovementDecision,
  context: SelfImprovementRunContext,
): string {
  const title = normalizeIssueTitle(decision.issueTitle || "Self-improvement proposal");
  const rawBody = String(decision.issueBody || "").trim();
  const bodyWithTitle = /^\s*#\s+/m.test(rawBody)
    ? rawBody
    : `# ${title}\n\n${rawBody}`;
  const marked = insertMarkersAfterH1(bodyWithTitle, [
    SELF_IMPROVEMENT_PROPOSAL_MARKER,
    SELF_IMPROVEMENT_DECISION_MARKER,
    selfImprovementRunMarker(context.runId),
  ].filter(Boolean));

  const footer = [
    "---",
    "",
    "Self-improvement decision trace:",
    `- Decision: \`${decision.decision}\``,
    `- Reason: ${decision.reason}`,
    context.runUrl ? `- Source run: ${context.runUrl}` : "",
    context.eventName ? `- Event: \`${context.eventName}\`` : "",
  ].filter(Boolean).join("\n");

  return `${marked.trim()}\n\n${footer}\n`;
}

function targetLabel(decision: SelfImprovementDecision): string {
  const number = decision.targetNumber || 0;
  return decision.decision === "continue_pr" ? `pull request #${number}` : `issue #${number}`;
}

export function buildSelfImprovementContinuationComment(
  decision: SelfImprovementDecision,
  context: SelfImprovementRunContext,
): string {
  const target = targetLabel(decision);
  const comment = String(decision.comment || "").trim();
  const summaryLines = [
    `- Decision: \`${decision.decision}\``,
    `- Reason: ${decision.reason}`,
    context.runUrl ? `- Source run: ${context.runUrl}` : "",
    context.eventName ? `- Event: \`${context.eventName}\`` : "",
  ].filter(Boolean);
  const markerLines = [
    SELF_IMPROVEMENT_DECISION_MARKER,
    selfImprovementRunMarker(context.runId),
  ].filter(Boolean);
  return [
    `Scheduled self-improvement selected this ${target} for continuation.`,
    summaryLines.join("\n"),
    comment,
    markerLines.join("\n"),
  ].filter((block) => block.trim()).join("\n\n").trim() + "\n";
}

export function writeTempMarkdownFile(prefix: string, markdown: string): string {
  const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
  const file = join(runnerTemp, `${prefix}-${randomBytes(8).toString("hex")}.md`);
  writeFileSync(file, markdown, "utf8");
  return file;
}
