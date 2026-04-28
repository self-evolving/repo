// Agent response parsing and status determination.

import {
  buildReviewSynthesisMarker,
  REVIEW_SYNTHESIS_HEADING,
} from "./review-synthesis.js";

/**
 * Run statuses for post-agent workflow steps.
 */
export type RunStatus = "success" | "no_changes" | "verify_failed" | "failed" | "unsupported";

/**
 * Determines the run status from agent exit code, change detection, and
 * verification result. This is the shared logic currently duplicated in
 * agent-implement.yml and agent-fix-pr.yml shell scripts.
 */
export function determineRunStatus(
  agentExitCode: number,
  hasChanges: boolean,
  verifyExitCode: number,
  hasBranchUpdate = false,
): RunStatus {
  if (agentExitCode !== 0) return "failed";
  if (!hasChanges && !hasBranchUpdate) return "no_changes";
  if (verifyExitCode !== 0) return "verify_failed";
  return "success";
}

// --- Status comment templates ---

export interface StatusCommentData {
  status: RunStatus;
  summary?: string;
  branch?: string;
  prUrl?: string;
  requestedBy?: string;
  approvalCommentUrl?: string;
}

export function formatImplementComment(data: StatusCommentData): string {
  switch (data.status) {
    case "success": {
      const lines = ["**Sepo implementation finished**", ""];
      if (data.branch) lines.push(`- Branch: \`${data.branch}\``);
      if (data.prUrl) lines.push(`- Pull request: ${data.prUrl}`);
      if (data.approvalCommentUrl) lines.push(`- Approval: ${data.approvalCommentUrl}`);
      lines.push("", data.summary ?? "");
      return lines.join("\n");
    }
    case "no_changes":
      return [
        "**Sepo did not produce code changes for this issue.**",
        "",
        "Please add more context or restate the request, then re-request implementation.",
        "",
        data.summary ?? "",
      ].join("\n");
    case "verify_failed":
      return [
        "**Sepo made changes, but lightweight verification failed.**",
        "",
        "Inspect the workflow logs before retrying implementation.",
        "",
        data.summary ?? "",
      ].join("\n");
    default:
      return [
        "**Sepo could not complete the implementation run.**",
        "",
        "Inspect the workflow logs and retry if appropriate.",
        "",
        data.summary ?? "",
      ].join("\n");
  }
}

export function formatFixPrComment(data: StatusCommentData): string {
  switch (data.status) {
    case "success": {
      let line = `**Sepo pushed fixes for this PR.** Branch: \`${data.branch ?? ""}\`.`;
      if (data.requestedBy) line += ` Requested by @${data.requestedBy}.`;
      if (data.approvalCommentUrl) line += ` Approval: ${data.approvalCommentUrl}.`;
      return [line, "", data.summary ?? ""].join("\n");
    }
    case "no_changes":
      return [
        "**Sepo did not produce code changes for this PR.**",
        "",
        "Please add more context or restate the requested fixes, then try again.",
        "",
        data.summary ?? "",
      ].join("\n");
    case "verify_failed":
      return [
        "**Sepo made changes, but lightweight verification failed.**",
        "",
        "Inspect the workflow logs before retrying the PR fix run.",
        "",
        data.summary ?? "",
      ].join("\n");
    case "unsupported":
      return [
        "**Sepo could not update this PR automatically.**",
        "",
        "PR fix runs currently support open same-repository pull requests only.",
        data.approvalCommentUrl ? `- Approval: ${data.approvalCommentUrl}` : "",
      ].filter(Boolean).join("\n");
    default:
      return [
        "**Sepo could not complete the PR fix run.**",
        "",
        "Inspect the workflow logs and retry if appropriate.",
        "",
        data.summary ?? "",
      ].join("\n");
  }
}

export function formatReviewComment(data: {
  synthesisBody: string;
  requestedBy?: string;
  approvalCommentUrl?: string;
}): string {
  const lines = [
    REVIEW_SYNTHESIS_HEADING,
    "",
    buildReviewSynthesisMarker(),
    "",
    "> Dual-agent review by **Claude** and **Codex**.",
  ];
  if (data.requestedBy) lines.push(`> Requested by @${data.requestedBy}.`);
  if (data.approvalCommentUrl) lines.push(`> Approval comment: ${data.approvalCommentUrl}`);
  lines.push("", data.synthesisBody);
  return lines.join("\n");
}

export function formatRubricsUpdateComment(data: {
  prNumber: string | number;
  rubricsRef: string;
  rubricsCommitted: boolean;
  runSucceeded: boolean;
  summary?: string;
}): string {
  const prNumber = String(data.prNumber || "").trim() || "unknown";
  const rubricsRef = String(data.rubricsRef || "").trim() || "agent/rubrics";
  const lines = ["## Rubrics Update", ""];

  if (!data.runSucceeded) {
    lines.push(`Rubrics update did not complete successfully for PR #${prNumber}; inspect the workflow logs.`);
  } else if (data.rubricsCommitted) {
    lines.push(`Updated \`${rubricsRef}\` from PR #${prNumber}.`);
  } else {
    lines.push(`No changes were committed to \`${rubricsRef}\` from PR #${prNumber}.`);
  }

  const summary = String(data.summary || "").trim();
  if (summary) {
    lines.push("", summary);
  }

  return lines.join("\n");
}

// --- JSON response parsing ---

/**
 * Extracts the first balanced JSON object from model output.
 * Tolerates fenced wrappers and markdown code fences inside string values.
 */
export function extractJsonObject(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "";

  // Try balanced brace extraction first
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) { escaped = false; }
        else if (ch === "\\") { escaped = true; }
        else if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") { depth++; continue; }
      if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }

  // Try fenced code block
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();

  return "";
}

export interface ImplementationResponse {
  summary: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export function summaryFromAgentResponse(route: string, raw: string): string {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  if (normalizedRoute === "implement" || normalizedRoute === "fix-pr") {
    return normalizeImplementationResponse(raw).summary;
  }
  return String(raw ?? "").trim();
}

export function normalizeImplementationResponse(raw: string): ImplementationResponse {
  const text = (raw ?? "").trim();
  if (!text) return { summary: "", commitMessage: "", prTitle: "", prBody: "" };

  const jsonStr = extractJsonObject(text);
  if (jsonStr) {
    try {
      const payload = JSON.parse(jsonStr) as Record<string, unknown>;
      const commitMessage = String(payload.commit_message ?? "").replace(/\s+/g, " ").trim();
      const prTitle = String(payload.pr_title ?? "").replace(/\s+/g, " ").trim();
      return {
        commitMessage,
        prBody: String(payload.pr_body ?? "").trim(),
        prTitle,
        summary: String(payload.summary ?? "").trim() || prTitle,
      };
    } catch { /* fall through */ }
  }

  return { summary: text, commitMessage: "", prTitle: "", prBody: "" };
}
