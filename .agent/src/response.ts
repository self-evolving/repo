// Agent response parsing and status determination.

import {
  buildReviewSynthesisHeadMarker,
  buildReviewSynthesisMarker,
  REVIEW_SYNTHESIS_HEADING,
} from "./review-synthesis.js";
import { buildFixPrStatusMarker } from "./fix-pr-status.js";

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

function formatMention(loginOrHandle: string): string {
  const value = String(loginOrHandle || "").trim();
  if (!value) return "";
  return value.startsWith("@") ? value : `@${value}`;
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
  const marker = buildFixPrStatusMarker();
  switch (data.status) {
    case "success": {
      let line = `**Sepo pushed fixes for this PR.** Branch: \`${data.branch ?? ""}\`.`;
      const requestedBy = data.requestedBy ? formatMention(data.requestedBy) : "";
      if (requestedBy) line += ` Requested by ${requestedBy}.`;
      if (data.approvalCommentUrl) line += ` Approval: ${data.approvalCommentUrl}.`;
      return [line, "", marker, "", data.summary ?? ""].join("\n");
    }
    case "no_changes":
      return [
        "**Sepo did not produce code changes for this PR.**",
        "",
        marker,
        "",
        "Please add more context or restate the requested fixes, then try again.",
        "",
        data.summary ?? "",
      ].join("\n");
    case "verify_failed":
      return [
        "**Sepo made changes, but lightweight verification failed.**",
        "",
        marker,
        "",
        "Inspect the workflow logs before retrying the PR fix run.",
        "",
        data.summary ?? "",
      ].join("\n");
    case "unsupported":
      return [
        "**Sepo could not update this PR automatically.**",
        "",
        marker,
        "",
        "PR fix runs currently support open same-repository pull requests only.",
        data.approvalCommentUrl ? `- Approval: ${data.approvalCommentUrl}` : "",
      ].filter(Boolean).join("\n");
    default:
      return [
        "**Sepo could not complete the PR fix run.**",
        "",
        marker,
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
  reviewedHeadSha?: string;
}): string {
  const lines = [
    REVIEW_SYNTHESIS_HEADING,
    "",
    buildReviewSynthesisMarker(),
  ];
  const headMarker = buildReviewSynthesisHeadMarker(data.reviewedHeadSha || "");
  if (headMarker) lines.push(headMarker);
  lines.push("", "> Dual-agent review by **Claude** and **Codex**.");
  if (data.requestedBy) lines.push(`> Requested by @${data.requestedBy}.`);
  if (data.approvalCommentUrl) lines.push(`> Approval comment: ${data.approvalCommentUrl}`);
  lines.push("", data.synthesisBody);
  return lines.join("\n");
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function formatBranchReference(ref: string, repoSlug?: string): string {
  const normalizedRepoSlug = String(repoSlug || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedRepoSlug)) {
    return `\`${ref}\``;
  }
  const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
  return `[\`${escapeMarkdownLinkText(ref)}\`](https://github.com/${normalizedRepoSlug}/tree/${encodedRef})`;
}

export function formatRubricsUpdateComment(data: {
  prNumber: string | number;
  rubricsRef: string;
  rubricsCommitted: boolean;
  runSucceeded: boolean;
  repoSlug?: string;
  summary?: string;
}): string {
  const prNumber = String(data.prNumber || "").trim() || "unknown";
  const rubricsRef = String(data.rubricsRef || "").trim() || "agent/rubrics";
  const rubricsRefLink = formatBranchReference(rubricsRef, data.repoSlug);
  const lines = ["## Rubrics Update", ""];

  if (!data.runSucceeded) {
    lines.push(`Rubrics update did not complete successfully for PR #${prNumber}; inspect the workflow logs.`);
  } else if (data.rubricsCommitted) {
    lines.push(`Updated ${rubricsRefLink} from PR #${prNumber}.`);
  } else {
    lines.push(`No changes were committed to ${rubricsRefLink} from PR #${prNumber}.`);
  }

  const summary = String(data.summary || "").trim();
  if (summary) {
    lines.push("", summary);
  }

  return lines.join("\n");
}

export function formatAddRubricsComment(data: {
  targetKind: string;
  targetNumber: string | number;
  rubricsRef: string;
  rubricsTargetRef?: string;
  writeMode?: "proposal_pr" | "direct_commit" | string;
  rubricsCommitted: boolean;
  runSucceeded: boolean;
  persistenceSucceeded?: boolean;
  proposalPrSucceeded?: boolean;
  proposalPrAction?: string;
  proposalPrUrl?: string;
  proposalBranch?: string;
  repoSlug?: string;
  summary?: string;
}): string {
  const targetKind = String(data.targetKind || "").trim() || "target";
  const targetNumber = String(data.targetNumber || "").trim() || "unknown";
  const rubricsRef = String(data.rubricsRef || "").trim() || "agent/rubrics";
  const rubricsTargetRef = String(data.rubricsTargetRef || "").trim() || rubricsRef;
  const proposalBranch = String(data.proposalBranch || rubricsTargetRef).trim();
  const writeMode = data.writeMode === "direct_commit" ? "direct_commit" : "proposal_pr";
  const rubricsRefLink = formatBranchReference(rubricsRef, data.repoSlug);
  const rubricsTargetRefLink = formatBranchReference(rubricsTargetRef, data.repoSlug);
  const proposalBranchLink = formatBranchReference(proposalBranch, data.repoSlug);
  const lines = ["## Add Rubrics", ""];

  if (!data.runSucceeded) {
    lines.push(`Rubric update did not complete successfully for ${targetKind} #${targetNumber}; inspect the workflow logs.`);
  } else if (writeMode === "proposal_pr" && data.rubricsCommitted && data.proposalPrSucceeded === false) {
    lines.push(`Rubric updates were pushed to ${proposalBranchLink}, but a PR targeting ${rubricsRefLink} was not opened; inspect the workflow logs.`);
  } else if (data.persistenceSucceeded === false) {
    lines.push(`Rubric updates were produced for ${targetKind} #${targetNumber}, but they were not persisted to ${rubricsTargetRefLink}; inspect the workflow logs.`);
  } else if (writeMode === "direct_commit") {
    if (data.rubricsCommitted) {
      lines.push(`Updated ${rubricsRefLink} directly from ${targetKind} #${targetNumber}.`);
    } else {
      lines.push(`No changes were committed to ${rubricsRefLink} from ${targetKind} #${targetNumber}.`);
    }
  } else if (data.rubricsCommitted && data.proposalPrUrl) {
    const action = String(data.proposalPrAction || "").trim() === "created"
      ? "Opened"
      : "Updated";
    lines.push(`${action} rubric PR ${data.proposalPrUrl} targeting ${rubricsRefLink} from ${targetKind} #${targetNumber}.`);
  } else if (data.rubricsCommitted) {
    lines.push(`Rubric updates were pushed to ${proposalBranchLink}, but a PR targeting ${rubricsRefLink} was not opened; inspect the workflow logs.`);
  } else {
    lines.push(`No rubric PR was opened for ${targetKind} #${targetNumber}; no changes were proposed for ${rubricsRefLink}.`);
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
