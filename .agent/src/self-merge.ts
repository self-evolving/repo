import { type IssueCommentRecord, type PrReviewRecord, type PrStatusCheckRecord } from "./github.js";
import {
  extractSelfApprovalApprovedHeadSha,
  SELF_APPROVAL_STATUS_MARKER,
} from "./self-approval.js";

export type SelfMergeConclusion = "merged" | "auto_merge_enabled" | "blocked" | "failed";
export type SelfMergeNextStep = "merge" | "enable_auto_merge" | "none";

export const SELF_MERGE_STATUS_MARKER = "<!-- sepo-agent-self-merge -->";

export interface SelfMergeApprovalResult {
  approved: boolean;
  approvedHeadSha: string;
  reason: string;
}

export interface SelfMergeStatusSummary {
  total: number;
  pending: number;
  failed: number;
  pendingNames: string[];
  failedNames: string[];
}

export interface SelfMergeResolveInput {
  allowSelfMerge: boolean;
  targetKind: string;
  prState: string;
  isDraft: boolean;
  currentHeadSha: string;
  reviewDecision: string;
  mergeStateStatus: string;
  mergeable: string;
  autoMergeRequestExists?: boolean;
  statusChecks: PrStatusCheckRecord[];
  approval: SelfMergeApprovalResult;
}

export interface SelfMergeResolveResult {
  conclusion: SelfMergeConclusion;
  nextStep: SelfMergeNextStep;
  markReady: boolean;
  reason: string;
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

function checkName(check: PrStatusCheckRecord, index: number): string {
  return String(check.name || "").trim() || `check ${index + 1}`;
}

export function summarizeStatusChecks(checks: PrStatusCheckRecord[]): SelfMergeStatusSummary {
  const failedTokens = new Set([
    "failure",
    "failed",
    "error",
    "cancelled",
    "canceled",
    "timed_out",
    "action_required",
    "startup_failure",
  ]);
  const pendingTokens = new Set([
    "pending",
    "queued",
    "in_progress",
    "waiting",
    "requested",
    "expected",
  ]);

  const pendingNames: string[] = [];
  const failedNames: string[] = [];
  checks.forEach((check, index) => {
    const tokens = [
      normalizeToken(check.conclusion),
      normalizeToken(check.state),
      normalizeToken(check.status),
    ].filter(Boolean);
    if (tokens.some((token) => failedTokens.has(token))) {
      failedNames.push(checkName(check, index));
      return;
    }
    if (tokens.some((token) => pendingTokens.has(token))) {
      pendingNames.push(checkName(check, index));
    }
  });

  return {
    total: checks.length,
    pending: pendingNames.length,
    failed: failedNames.length,
    pendingNames,
    failedNames,
  };
}

export function evaluateSelfMergeApproval(input: {
  reviews: PrReviewRecord[];
  comments?: IssueCommentRecord[];
  trustedActorLogin: string;
  currentHeadSha: string;
}): SelfMergeApprovalResult {
  const trustedActor = normalizeActorLogin(input.trustedActorLogin);
  const currentHeadSha = String(input.currentHeadSha || "").trim();
  if (!trustedActor) {
    return {
      approved: false,
      approvedHeadSha: "",
      reason: "could not resolve trusted agent actor for self-merge approval",
    };
  }
  if (!currentHeadSha) {
    return {
      approved: false,
      approvedHeadSha: "",
      reason: "could not resolve pull request head SHA for self-merge approval",
    };
  }

  const reviewApprovals = input.reviews
    .map((review, index) => ({
      index,
      source: "review" as const,
      state: normalizeToken(review.state),
      author: normalizeActorLogin(review.authorLogin),
      body: String(review.body || ""),
      commitId: String(review.commitId || "").trim(),
      submittedAtMs: createdAtMs(review.submittedAt),
    }))
    .filter((review) => (
      review.state === "approved" &&
      review.author === trustedActor &&
      review.body.includes(SELF_APPROVAL_STATUS_MARKER)
    ));

  const commentApprovals = (input.comments || [])
    .map((comment, index) => ({
      index: input.reviews.length + index,
      source: "status" as const,
      author: normalizeActorLogin(comment.authorLogin),
      commitId: extractSelfApprovalApprovedHeadSha(comment.body || ""),
      submittedAtMs: createdAtMs(comment.createdAt),
    }))
    .filter((comment) => (
      comment.author === trustedActor &&
      Boolean(comment.commitId)
    ));

  const selfApprovals = [...reviewApprovals, ...commentApprovals]
    .sort((left, right) => left.submittedAtMs - right.submittedAtMs || left.index - right.index);

  const currentHeadApproval = [...selfApprovals].reverse().find((review) => review.commitId === currentHeadSha);
  if (currentHeadApproval) {
    return {
      approved: true,
      approvedHeadSha: currentHeadApproval.commitId,
      reason: currentHeadApproval.source === "status"
        ? "found current-head self-approval status from the authenticated Sepo actor"
        : "found current-head self-approval review from the authenticated Sepo actor",
    };
  }

  const latest = selfApprovals[selfApprovals.length - 1];
  if (latest) {
    return {
      approved: false,
      approvedHeadSha: latest.commitId,
      reason: "latest self-approval reviewed a different head SHA",
    };
  }

  return {
    approved: false,
    approvedHeadSha: "",
    reason: "missing current-head self-approval from the authenticated Sepo actor",
  };
}

function formatCheckNames(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown}, and ${names.length - 3} more` : shown;
}

function isCurrentlyMergeable(input: SelfMergeResolveInput): boolean {
  const mergeState = normalizeToken(input.mergeStateStatus);
  const mergeable = normalizeToken(input.mergeable);
  return (
    (mergeState === "clean" || mergeState === "has_hooks") &&
    (mergeable === "mergeable" || mergeable === "true")
  );
}

function canEnableAutoMerge(input: SelfMergeResolveInput): boolean {
  const mergeState = normalizeToken(input.mergeStateStatus);
  const mergeable = normalizeToken(input.mergeable);
  if (mergeable === "conflicting" || mergeable === "false") return false;
  if (mergeState === "dirty" || mergeState === "draft" || mergeState === "behind") return false;
  return ["blocked", "clean", "has_hooks", "unknown", "unstable"].includes(mergeState);
}

export function resolveSelfMerge(input: SelfMergeResolveInput): SelfMergeResolveResult {
  let markReady = false;

  if (!input.allowSelfMerge) {
    return {
      conclusion: "blocked",
      nextStep: "none",
      markReady: false,
      reason: "AGENT_ALLOW_SELF_MERGE is not enabled",
    };
  }

  if (normalizeToken(input.targetKind) !== "pull_request") {
    return {
      conclusion: "blocked",
      nextStep: "none",
      markReady: false,
      reason: "self-merge is only supported for pull requests",
    };
  }

  if (normalizeToken(input.prState) !== "open") {
    return {
      conclusion: "blocked",
      nextStep: "none",
      markReady: false,
      reason: `pull request is ${String(input.prState || "not open").toLowerCase()}`,
    };
  }

  if (input.isDraft) {
    markReady = true;
  }

  if (!input.currentHeadSha.trim()) {
    return {
      conclusion: "failed",
      nextStep: "none",
      markReady: false,
      reason: "could not resolve pull request head SHA for self-merge",
    };
  }

  if (!input.approval.approved) {
    return {
      conclusion: "blocked",
      nextStep: "none",
      markReady: false,
      reason: input.approval.reason || "missing current-head self-approval",
    };
  }

  if (normalizeToken(input.reviewDecision) === "changes_requested") {
    return {
      conclusion: "blocked",
      nextStep: "none",
      markReady: false,
      reason: "pull request has blocking requested changes",
    };
  }

  const checks = summarizeStatusChecks(input.statusChecks);
  if (checks.failed > 0) {
    return {
      conclusion: "blocked",
      nextStep: "none",
      markReady: false,
      reason: `status checks are failing: ${formatCheckNames(checks.failedNames)}`,
    };
  }

  if (checks.pending > 0) {
    const autoMergeEligible = canEnableAutoMerge(input);
    if (input.autoMergeRequestExists && autoMergeEligible) {
      return {
        conclusion: "auto_merge_enabled",
        nextStep: "none",
        markReady,
        reason: "GitHub auto-merge is already enabled while checks are pending",
      };
    }
    if (autoMergeEligible) {
      return {
        conclusion: "auto_merge_enabled",
        nextStep: "enable_auto_merge",
        markReady,
        reason: `status checks are pending: ${formatCheckNames(checks.pendingNames)}; enabling GitHub auto-merge`,
      };
    }
    return {
      conclusion: "blocked",
      nextStep: "none",
      markReady,
      reason: `pull request is not eligible for auto-merge while checks are pending (merge state: ${input.mergeStateStatus || "unknown"})`,
    };
  }

  if (isCurrentlyMergeable(input)) {
    return {
      conclusion: "merged",
      nextStep: "merge",
      markReady,
      reason: "pull request is approved, current, and mergeable",
    };
  }

  return {
    conclusion: "blocked",
    nextStep: "none",
    markReady,
    reason: `pull request is not currently mergeable (merge state: ${input.mergeStateStatus || "unknown"})`,
  };
}

export function formatSelfMergeBody(input: {
  conclusion: SelfMergeConclusion | string;
  reason: string;
  runUrl?: string;
}): string {
  const conclusion = input.conclusion || "unknown";
  const status = conclusion === "merged"
    ? "Merged"
    : conclusion === "auto_merge_enabled"
      ? "Auto-merge enabled"
      : conclusion === "failed"
        ? "Failed"
        : "Blocked";
  const lines = [
    "Sepo self-merge completed.",
    "",
    "| Status | Conclusion |",
    "|---|---|",
    `| ${status} | \`${conclusion}\` |`,
    "",
    `Reason: ${input.reason || "No reason provided."}`,
  ];
  if (input.runUrl) {
    lines.push("", `Run: ${input.runUrl}`);
  }
  lines.push("", SELF_MERGE_STATUS_MARKER);
  return lines.join("\n");
}
