import { extractReviewConclusion, extractReviewRecommendedNextStep } from "./handoff.js";
import { extractJsonObject } from "./response.js";
import {
  extractReviewSynthesisHeadSha,
  isReviewSynthesisBody,
} from "./review-synthesis.js";

export type SelfApprovalVerdict = "approve" | "request_changes" | "blocked";

export const SELF_APPROVAL_STATUS_MARKER = "<!-- sepo-agent-self-approval -->";
const SELF_APPROVAL_HEAD_MARKER_RE = /<!--\s*sepo-agent-self-approval-head:\s*([^\s>]+)\s*-->/i;
const SELF_APPROVAL_APPROVED_HEAD_MARKER_RE = /<!--\s*sepo-agent-self-approval-approved-head:\s*([^\s>]+)\s*-->/i;

export interface SelfApprovalDecision {
  verdict: SelfApprovalVerdict;
  reason: string;
  handoffContext: string;
  inspectedHeadSha: string;
}

export interface SelfApprovalResolveInput {
  allowSelfApprove: boolean;
  targetKind: string;
  prState: string;
  expectedHeadSha: string;
  currentHeadSha: string;
  decision: SelfApprovalDecision | null;
  approvalActorAllowed?: boolean;
  approvalActorReason?: string;
  approvalProvenanceTrusted?: boolean;
  approvalProvenanceReason?: string;
}

export interface SelfApprovalResolveResult {
  conclusion: "approved" | "request_changes" | "blocked" | "failed";
  shouldApprove: boolean;
  reason: string;
  handoffContext: string;
}

export interface SelfApprovalSignalComment {
  body: string;
  authorLogin: string;
  createdAt?: string | number | null;
}

export interface SelfApprovalProvenanceResult {
  trusted: boolean;
  reason: string;
}

export interface SelfApprovalActorResult {
  allowed: boolean;
  reason: string;
  sameActor?: boolean;
}

function normalizeToken(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeActorLogin(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^app\//i, "")
    .replace(/\[bot\]$/i, "");
}

function createdAtMs(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function envFlagEnabled(value: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes(normalizeToken(value || ""));
}

export function evaluateSelfApprovalActor(input: {
  approvalActorLogin: string;
  prAuthorLogin: string;
  allowSameActor?: boolean;
}): SelfApprovalActorResult {
  const approvalActor = normalizeActorLogin(input.approvalActorLogin);
  const prAuthor = normalizeActorLogin(input.prAuthorLogin);
  if (!approvalActor) {
    return {
      allowed: false,
      reason: "could not resolve approval actor for self-approval",
    };
  }
  if (!prAuthor) {
    return {
      allowed: false,
      reason: "could not resolve pull request author for self-approval",
    };
  }
  if (approvalActor === prAuthor) {
    if (input.allowSameActor) {
      return {
        allowed: true,
        sameActor: true,
        reason: "same approval actor is allowed because self-approval and self-merge are both enabled",
      };
    }
    return {
      allowed: false,
      sameActor: true,
      reason: "approval actor matches the pull request author",
    };
  }
  return {
    allowed: true,
    sameActor: false,
    reason: "approval actor is distinct from pull request author",
  };
}

function normalizeVerdict(value: string): SelfApprovalVerdict | null {
  const normalized = normalizeToken(value);
  if (normalized === "approve" || normalized === "approved") return "approve";
  if (
    normalized === "request_changes" ||
    normalized === "changes_requested" ||
    normalized === "changes_needed" ||
    normalized === "needs_changes"
  ) {
    return "request_changes";
  }
  if (normalized === "blocked" || normalized === "block") return "blocked";
  return null;
}

export function evaluateSelfApprovalProvenance(input: {
  comments: SelfApprovalSignalComment[];
  trustedActorLogin: string;
  expectedHeadSha: string;
  allowHumanDecisionGate?: boolean;
}): SelfApprovalProvenanceResult {
  const trustedActor = normalizeActorLogin(input.trustedActorLogin);
  const expectedHeadSha = String(input.expectedHeadSha || "").trim();
  if (!trustedActor) {
    return {
      trusted: false,
      reason: "could not resolve trusted agent actor for self-approval provenance",
    };
  }
  if (!expectedHeadSha) {
    return {
      trusted: false,
      reason: "could not resolve expected head SHA for self-approval provenance",
    };
  }

  const signals = input.comments
    .map((comment, index) => {
      const author = normalizeActorLogin(comment.authorLogin);
      if (!author || author !== trustedActor) return null;

      const body = String(comment.body || "");
      if (!isReviewSynthesisBody(body)) return null;

      return {
        index,
        createdAtMs: createdAtMs(comment.createdAt),
        conclusion: extractReviewConclusion(body),
        recommendedNextStep: extractReviewRecommendedNextStep(body),
        reviewedHeadSha: extractReviewSynthesisHeadSha(body),
      };
    })
    .filter((signal): signal is {
      index: number;
      createdAtMs: number;
      conclusion: string;
      recommendedNextStep: string;
      reviewedHeadSha: string;
    } => Boolean(signal))
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.index - right.index);

  const latest = signals[signals.length - 1];
  if (!latest) {
    return {
      trusted: false,
      reason: "missing trusted review synthesis for self-approval",
    };
  }

  if (!latest.reviewedHeadSha) {
    return {
      trusted: false,
      reason: "latest trusted review synthesis is missing reviewed head SHA",
    };
  }
  if (latest.reviewedHeadSha !== expectedHeadSha) {
    return {
      trusted: false,
      reason: "latest trusted review synthesis reviewed a different head SHA",
    };
  }

  const conclusion = latest.conclusion || "unknown";
  const recommendedNextStep = normalizeToken(latest.recommendedNextStep || "");
  if (conclusion === "ship") {
    return {
      trusted: true,
      reason: "latest trusted review synthesis verdict is SHIP for current head",
    };
  }
  if (input.allowHumanDecisionGate && recommendedNextStep === "human_decision") {
    return {
      trusted: true,
      reason: `latest trusted review synthesis recommended HUMAN_DECISION after ${conclusion} for current head`,
    };
  }

  return {
    trusted: false,
    reason: `latest trusted review synthesis verdict is ${conclusion}, not SHIP`,
  };
}

export function parseSelfApprovalDecision(raw: string): SelfApprovalDecision | null {
  const json = extractJsonObject(raw);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const verdict = normalizeVerdict(String(record.verdict || record.decision || ""));
  if (!verdict) return null;

  const reason = String(record.reason || record.rationale || "").trim();
  const handoffContext = String(record.handoff_context ?? record.handoffContext ?? "").trim();
  const inspectedHeadSha = String(
    record.inspected_head_sha ?? record.inspectedHeadSha ?? record.head_sha ?? record.headSha ?? "",
  ).trim();

  return {
    verdict,
    reason: reason || "self-approval agent returned no reason",
    handoffContext,
    inspectedHeadSha,
  };
}

export function resolveSelfApproval(input: SelfApprovalResolveInput): SelfApprovalResolveResult {
  if (!input.allowSelfApprove) {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      reason: "AGENT_ALLOW_SELF_APPROVE is not enabled",
      handoffContext: "",
    };
  }

  if (normalizeToken(input.targetKind) !== "pull_request") {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      reason: "self-approval is only supported for pull requests",
      handoffContext: "",
    };
  }

  if (normalizeToken(input.prState) !== "open") {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      reason: `pull request is ${input.prState.toLowerCase() || "not open"}`,
      handoffContext: "",
    };
  }

  if (!input.decision) {
    return {
      conclusion: "failed",
      shouldApprove: false,
      reason: "self-approval agent response was missing a valid JSON decision",
      handoffContext: "",
    };
  }

  const expectedHeadSha = input.expectedHeadSha.trim();
  const currentHeadSha = input.currentHeadSha.trim();
  const inspectedHeadSha = input.decision.inspectedHeadSha.trim();
  if (!expectedHeadSha || !currentHeadSha || expectedHeadSha !== currentHeadSha) {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      reason: "pull request head changed after self-approval inspection",
      handoffContext: input.decision.handoffContext,
    };
  }

  if (input.decision.verdict === "approve") {
    if (!inspectedHeadSha) {
      return {
        conclusion: "blocked",
        shouldApprove: false,
        reason: "self-approval approval verdict was missing inspected head SHA",
        handoffContext: input.decision.handoffContext,
      };
    }

    if (inspectedHeadSha !== expectedHeadSha) {
      return {
        conclusion: "blocked",
        shouldApprove: false,
        reason: "self-approval agent reported a different inspected head SHA",
        handoffContext: input.decision.handoffContext,
      };
    }

    if (input.approvalActorAllowed !== true) {
      return {
        conclusion: "blocked",
        shouldApprove: false,
        reason: input.approvalActorReason || "approval actor could not be verified as distinct from pull request author",
        handoffContext: input.decision.handoffContext,
      };
    }

    if (input.approvalProvenanceTrusted !== true) {
      return {
        conclusion: "blocked",
        shouldApprove: false,
        reason: input.approvalProvenanceReason || "missing trusted review synthesis for self-approval",
        handoffContext: input.decision.handoffContext,
      };
    }

    return {
      conclusion: "approved",
      shouldApprove: true,
      reason: input.decision.reason,
      handoffContext: input.decision.handoffContext,
    };
  }

  if (input.decision.verdict === "request_changes") {
    return {
      conclusion: "request_changes",
      shouldApprove: false,
      reason: input.decision.reason,
      handoffContext: input.decision.handoffContext || input.decision.reason,
    };
  }

  return {
    conclusion: "blocked",
    shouldApprove: false,
    reason: input.decision.reason,
    handoffContext: input.decision.handoffContext,
  };
}

export function buildSelfApprovalHeadMarker(headSha: string): string {
  const trimmed = String(headSha || "").trim();
  return trimmed ? `<!-- sepo-agent-self-approval-head: ${trimmed} -->` : "";
}

export function extractSelfApprovalHeadSha(body: string): string {
  return String(body || "").match(SELF_APPROVAL_HEAD_MARKER_RE)?.[1]?.trim() || "";
}

export function buildSelfApprovalApprovedHeadMarker(headSha: string): string {
  const trimmed = String(headSha || "").trim();
  return trimmed ? `<!-- sepo-agent-self-approval-approved-head: ${trimmed} -->` : "";
}

export function extractSelfApprovalApprovedHeadSha(body: string): string {
  const text = String(body || "");
  const footerIndex = text.lastIndexOf(SELF_APPROVAL_STATUS_MARKER);
  if (footerIndex < 0) return "";

  const footerLines = text
    .slice(footerIndex)
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (footerLines[0] !== SELF_APPROVAL_STATUS_MARKER) return "";

  return footerLines[1]?.match(SELF_APPROVAL_APPROVED_HEAD_MARKER_RE)?.[1]?.trim() || "";
}

export function formatSelfApprovalBody(input: {
  conclusion: string;
  reason: string;
  handoffContext?: string;
  approved?: boolean;
  runUrl?: string;
  headSha?: string;
}): string {
  const conclusion = input.conclusion || "unknown";
  const status = input.approved
    ? "Approved"
    : conclusion === "blocked"
      ? "Blocked"
      : conclusion === "failed"
        ? "Failed"
        : conclusion === "request_changes"
          ? "Changes requested"
          : "Not approved";
  const lines = [
    "Sepo self-approval completed.",
    "",
    "| Status | Conclusion |",
    "|---|---|",
    `| ${status} | \`${conclusion}\` |`,
    "",
    `Reason: ${input.reason || "No reason provided."}`,
  ];
  const context = String(input.handoffContext || "").trim();
  if (context && !input.approved) {
    lines.push("", "Follow-up context:", context);
  }
  if (input.runUrl) {
    lines.push("", `Run: ${input.runUrl}`);
  }
  const headSha = String(input.headSha || "").trim();
  if (headSha) {
    lines.push("", `Head SHA: \`${headSha}\``, buildSelfApprovalHeadMarker(headSha));
  }
  lines.push("", SELF_APPROVAL_STATUS_MARKER);
  if (input.approved && headSha) {
    lines.push(buildSelfApprovalApprovedHeadMarker(headSha));
  }
  return lines.join("\n");
}
