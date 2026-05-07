import { extractJsonObject } from "./response.js";
import { extractReviewConclusion } from "./handoff.js";
import { isReviewSynthesisBody } from "./review-synthesis.js";

export type SelfApprovalVerdict = "approve" | "request_changes" | "blocked";

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
  approvalProvenanceTrusted?: boolean;
  approvalProvenanceReason?: string;
}

export interface SelfApprovalResolveResult {
  conclusion: "approved" | "request_changes" | "blocked" | "failed";
  shouldApprove: boolean;
  shouldOrchestrate: boolean;
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

export function envFlagEnabled(value: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes(normalizeToken(value || ""));
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

function isRubricsReviewBody(body: string): boolean {
  return /(?:^|\r?\n)## Rubrics Review(?:\s|$)/.test(body);
}

function extractRubricsVerdict(markdown: string): string {
  const text = markdown || "";
  const finalMatch = text.match(/##\s*Final Rubric Verdict\s+`?([A-Z_ -]+)`?/i);
  if (finalMatch) return normalizeToken(finalMatch[1]);

  const tableMatch = text.match(/\|\s*\d+\s*\|\s*([A-Z_ -]+)\s*\|\s*\d+\s*\|/i);
  return tableMatch ? normalizeToken(tableMatch[1]) : "unknown";
}

function createdAtMs(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function evaluateSelfApprovalProvenance(input: {
  comments: SelfApprovalSignalComment[];
  trustedActorLogin: string;
}): SelfApprovalProvenanceResult {
  const trustedActor = normalizeActorLogin(input.trustedActorLogin);
  if (!trustedActor) {
    return {
      trusted: false,
      reason: "could not resolve trusted agent actor for self-approval provenance",
    };
  }

  const signals = input.comments
    .map((comment, index) => {
      const author = normalizeActorLogin(comment.authorLogin);
      if (!author || author !== trustedActor) return null;

      const body = String(comment.body || "");
      if (isReviewSynthesisBody(body)) {
        return {
          index,
          createdAtMs: createdAtMs(comment.createdAt),
          kind: "review synthesis",
          conclusion: extractReviewConclusion(body),
        };
      }
      if (isRubricsReviewBody(body)) {
        return {
          index,
          createdAtMs: createdAtMs(comment.createdAt),
          kind: "rubrics review",
          conclusion: extractRubricsVerdict(body),
        };
      }
      return null;
    })
    .filter((signal): signal is {
      index: number;
      createdAtMs: number;
      kind: "review synthesis" | "rubrics review";
      conclusion: string;
    } => Boolean(signal))
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.index - right.index);

  const latest = signals[signals.length - 1];
  if (!latest) {
    return {
      trusted: false,
      reason: "missing trusted review/rubrics signal for self-approval",
    };
  }

  if (latest.kind === "review synthesis" && latest.conclusion === "ship") {
    return { trusted: true, reason: "latest trusted review synthesis verdict is SHIP" };
  }
  if (latest.kind === "rubrics review" && latest.conclusion === "pass") {
    return { trusted: true, reason: "latest trusted rubrics review verdict is PASS" };
  }

  const expected = latest.kind === "review synthesis" ? "SHIP" : "PASS";
  return {
    trusted: false,
    reason: `latest trusted ${latest.kind} verdict is ${latest.conclusion || "unknown"}, not ${expected}`,
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
      shouldOrchestrate: false,
      reason: "AGENT_ALLOW_SELF_APPROVE is not enabled",
      handoffContext: "",
    };
  }

  if (normalizeToken(input.targetKind) !== "pull_request") {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      shouldOrchestrate: false,
      reason: "self-approval is only supported for pull requests",
      handoffContext: "",
    };
  }

  if (normalizeToken(input.prState) !== "open") {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      shouldOrchestrate: false,
      reason: `pull request is ${input.prState.toLowerCase() || "not open"}`,
      handoffContext: "",
    };
  }

  if (!input.decision) {
    return {
      conclusion: "failed",
      shouldApprove: false,
      shouldOrchestrate: false,
      reason: "self-approval agent response was missing a valid JSON decision",
      handoffContext: "",
    };
  }

  const expectedHeadSha = input.expectedHeadSha.trim();
  const currentHeadSha = input.currentHeadSha.trim();
  const inspectedHeadSha = input.decision.inspectedHeadSha.trim();
  if (input.decision.verdict === "approve" && !inspectedHeadSha) {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      shouldOrchestrate: false,
      reason: "self-approval approval verdict was missing inspected head SHA",
      handoffContext: input.decision.handoffContext,
    };
  }

  if (!expectedHeadSha || !currentHeadSha || expectedHeadSha !== currentHeadSha) {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      shouldOrchestrate: false,
      reason: "pull request head changed after self-approval inspection",
      handoffContext: input.decision.handoffContext,
    };
  }

  if (inspectedHeadSha && inspectedHeadSha !== expectedHeadSha) {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      shouldOrchestrate: false,
      reason: "self-approval agent reported a different inspected head SHA",
      handoffContext: input.decision.handoffContext,
    };
  }

  if (input.approvalProvenanceTrusted === false) {
    return {
      conclusion: "blocked",
      shouldApprove: false,
      shouldOrchestrate: false,
      reason: input.approvalProvenanceReason || "missing trusted review/rubrics signal for self-approval",
      handoffContext: input.decision.handoffContext,
    };
  }

  if (input.decision.verdict === "approve") {
    return {
      conclusion: "approved",
      shouldApprove: true,
      shouldOrchestrate: false,
      reason: input.decision.reason,
      handoffContext: input.decision.handoffContext,
    };
  }

  if (input.decision.verdict === "request_changes") {
    return {
      conclusion: "request_changes",
      shouldApprove: false,
      shouldOrchestrate: true,
      reason: input.decision.reason,
      handoffContext: input.decision.handoffContext || input.decision.reason,
    };
  }

  return {
    conclusion: "blocked",
    shouldApprove: false,
    shouldOrchestrate: false,
    reason: input.decision.reason,
    handoffContext: input.decision.handoffContext,
  };
}

export function formatSelfApprovalBody(input: {
  conclusion: string;
  reason: string;
  handoffContext?: string;
  approved?: boolean;
  runUrl?: string;
}): string {
  const status = input.approved ? "Approved" : "Not approved";
  const conclusion = input.conclusion || "unknown";
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
  lines.push("", "<!-- sepo-agent-self-approval -->");
  return lines.join("\n");
}
