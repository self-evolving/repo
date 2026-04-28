import { extractJsonObject } from "./response.js";

export type AgentAction = "implement" | "review" | "fix-pr";
export type HandoffDecisionKind = "dispatch" | "stop" | "skip";
export type AutomationMode = "disabled" | "heuristics" | "agent";
export type HandoffMarkerState = "pending" | "dispatched" | "failed";
export type PlannerDecisionKind = "handoff" | "stop" | "blocked";

export interface HandoffInput {
  automationMode: string;
  sourceAction: string;
  sourceConclusion: string;
  targetNumber: string;
  nextTargetNumber?: string;
  currentRound: number;
  maxRounds: number;
  plannerDecision?: PlannerDecision | null;
}

export interface HandoffDecision {
  decision: HandoffDecisionKind;
  nextAction?: AgentAction;
  targetNumber?: string;
  reason: string;
  nextRound: number;
  handoffContext?: string;
}

export interface HandoffDedupeInput {
  repo: string;
  sourceRunId: string;
  sourceAction: string;
  sourceTargetNumber: string;
  nextAction: string;
  nextTargetNumber: string;
  nextRound: number;
}

export interface HandoffMarkerInfo {
  state: HandoffMarkerState;
  createdAtMs: number | null;
}

export interface PlannerDecision {
  decision: PlannerDecisionKind;
  nextAction?: AgentAction;
  reason: string;
  handoffContext?: string;
}

const REVIEW_TO_FIX_PR = new Set(["minor_issues", "needs_rework", "changes_requested"]);
const HANDOFF_MARKER_PREFIX = "sepo-agent-handoff";

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeAutomationMode(value: string): AutomationMode {
  const normalized = normalizeToken(String(value || ""));
  if (!normalized || normalized === "false") {
    return "disabled";
  }
  // Backward-compatible alias for early boolean-style automation config.
  if (normalized === "true") {
    return "heuristics";
  }
  // The built-in heuristic state machine. Use the canonical plural spelling only.
  if (normalized === "heuristics") {
    return "heuristics";
  }
  if (normalized === "agent") {
    return "agent";
  }
  return "disabled";
}

export function automationModeAllowsHandoff(value: string): boolean {
  return normalizeAutomationMode(value) !== "disabled";
}

export function normalizeConclusion(value: string): string {
  const normalized = normalizeToken(value);
  if (normalized === "success") return "success";
  if (normalized === "ship") return "ship";
  if (normalized === "minor_issues") return "minor_issues";
  if (normalized === "needs_rework") return "needs_rework";
  if (normalized === "changes_requested") return "changes_requested";
  return normalized || "unknown";
}

function normalizeAgentAction(value: string): AgentAction | null {
  const normalized = normalizeToken(value);
  if (normalized === "implement") return "implement";
  if (normalized === "review") return "review";
  if (normalized === "fix_pr") return "fix-pr";
  return null;
}

export function parsePlannerDecision(raw: string): PlannerDecision | null {
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
  const decisionToken = normalizeToken(String(record.decision || ""));
  const decision: PlannerDecisionKind | null = decisionToken === "handoff"
    ? "handoff"
    : decisionToken === "stop"
      ? "stop"
      : decisionToken === "blocked"
        ? "blocked"
        : null;
  if (!decision) return null;

  const nextAction = normalizeAgentAction(String(record.next_action ?? record.nextAction ?? ""));
  const reason = String(record.reason || "").trim();
  const handoffContext = String(record.handoff_context ?? record.handoffContext ?? "").trim();
  const plannerDecision: PlannerDecision = {
    decision,
    nextAction: nextAction || undefined,
    reason: reason || "agent planner returned no reason",
  };
  if (handoffContext) {
    plannerDecision.handoffContext = handoffContext;
  }
  return plannerDecision;
}

export function extractReviewConclusion(markdown: string): string {
  const text = markdown || "";
  const verdictMatch = text.match(/##\s*Final Verdict\s*\n+\s*[-*]?\s*`?([A-Z_ -]+)`?/i);
  if (verdictMatch) return normalizeConclusion(verdictMatch[1]);

  const inlineMatch = text.match(/\b(SHIP|MINOR[_ -]ISSUES|NEEDS[_ -]REWORK|CHANGES[_ -]REQUESTED)\b/i);
  return inlineMatch ? normalizeConclusion(inlineMatch[1]) : "unknown";
}

export function buildHandoffDedupeKey(input: HandoffDedupeInput): string {
  return [
    "handoff",
    input.repo.trim().toLowerCase(),
    input.sourceRunId.trim() || "unknown-run",
    normalizeToken(input.sourceAction),
    input.sourceTargetNumber.trim(),
    normalizeToken(input.nextAction),
    input.nextTargetNumber.trim(),
    String(input.nextRound),
  ].join(":");
}

function encodeMarkerKey(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

export function buildHandoffMarker(
  key: string,
  state: HandoffMarkerState = "dispatched",
  createdAtMs = Date.now(),
): string {
  return `<!-- ${HANDOFF_MARKER_PREFIX} state:${state} created:${Math.trunc(createdAtMs)} base64:${encodeMarkerKey(key)} -->`;
}

export function parseHandoffMarker(body: string, key: string): HandoffMarkerInfo | null {
  const encoded = escapeRegex(encodeMarkerKey(key));
  const markerRe = new RegExp(
    `<!--\\s*${HANDOFF_MARKER_PREFIX}(?:\\s+state:(pending|dispatched|failed))?(?:\\s+created:(\\d+))?\\s+base64:${encoded}\\s*-->`,
    "i",
  );
  const match = String(body || "").match(markerRe);
  if (!match) return null;
  const rawState = String(match[1] || "dispatched").toLowerCase();
  const state: HandoffMarkerState = rawState === "pending" || rawState === "failed"
    ? rawState
    : "dispatched";
  const createdAtMs = match[2] ? Number.parseInt(match[2], 10) : NaN;
  return {
    state,
    createdAtMs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : null,
  };
}

export function getHandoffMarkerState(body: string, key: string): HandoffMarkerState | null {
  return parseHandoffMarker(body, key)?.state ?? null;
}

export function hasHandoffMarker(body: string, key: string): boolean {
  return parseHandoffMarker(body, key) !== null;
}

export function isPendingHandoffMarkerStale(
  marker: HandoffMarkerInfo,
  nowMs: number,
  ttlMs: number,
): boolean {
  if (marker.state !== "pending") return false;
  if (!marker.createdAtMs) return true;
  return marker.createdAtMs + ttlMs <= nowMs;
}

export function formatHandoffMarkerComment(args: {
  key: string;
  state?: HandoffMarkerState;
  sourceAction: string;
  nextAction: string;
  nextRound: number;
  maxRounds: number;
  reason: string;
  error?: string;
  createdAtMs?: number;
}): string {
  const state = args.state || "dispatched";
  const status = state === "pending"
    ? "pending"
    : state === "failed"
      ? "failed"
      : "dispatched";
  const lines = [
    `Sepo automation handoff ${status}: \`${args.sourceAction}\` -> \`${args.nextAction}\` (round ${args.nextRound}/${args.maxRounds}).`,
    "",
    args.reason,
  ];

  if (args.error) {
    lines.push("", `Error: ${args.error}`);
  }

  lines.push("", buildHandoffMarker(args.key, state, args.createdAtMs));
  return lines.join("\n");
}

function decideHeuristicHandoff(input: HandoffInput): HandoffDecision {
  const nextRound = input.currentRound + 1;
  const sourceAction = normalizeToken(input.sourceAction);
  const conclusion = normalizeConclusion(input.sourceConclusion);
  const nextTarget = (input.nextTargetNumber || input.targetNumber).trim();

  if (sourceAction === "implement") {
    if (conclusion !== "success") {
      return { decision: "stop", reason: `implement concluded ${conclusion}`, nextRound };
    }
    if (!input.nextTargetNumber?.trim()) {
      return { decision: "stop", reason: "implement did not produce a pull request target", nextRound };
    }
    return {
      decision: "dispatch",
      nextAction: "review",
      targetNumber: nextTarget,
      reason: "implementation succeeded; dispatching review",
      nextRound,
    };
  }

  if (sourceAction === "fix_pr") {
    if (conclusion !== "success") {
      return { decision: "stop", reason: `fix-pr concluded ${conclusion}`, nextRound };
    }
    return {
      decision: "dispatch",
      nextAction: "review",
      targetNumber: nextTarget,
      reason: "PR fixes succeeded; dispatching review",
      nextRound,
    };
  }

  if (sourceAction === "review") {
    if (conclusion === "ship") {
      return { decision: "stop", reason: "review verdict is SHIP", nextRound };
    }
    if (REVIEW_TO_FIX_PR.has(conclusion)) {
      return {
        decision: "dispatch",
        nextAction: "fix-pr",
        targetNumber: nextTarget,
        reason: `review verdict is ${conclusion}; dispatching fix-pr`,
        nextRound,
      };
    }
    return { decision: "stop", reason: `review verdict ${conclusion} has no handoff`, nextRound };
  }

  return { decision: "stop", reason: `unsupported source action ${input.sourceAction}`, nextRound };
}

function decideAgentHandoff(input: HandoffInput): HandoffDecision {
  const nextRound = input.currentRound + 1;
  const plannerDecision = input.plannerDecision;
  if (!plannerDecision) {
    return { decision: "stop", reason: "agent planner decision missing or invalid", nextRound };
  }
  if (plannerDecision.decision === "stop" || plannerDecision.decision === "blocked") {
    return {
      decision: "stop",
      reason: `agent planner ${plannerDecision.decision}: ${plannerDecision.reason}`,
      nextRound,
    };
  }
  if (!plannerDecision.nextAction) {
    return { decision: "stop", reason: "agent planner requested handoff without next_action", nextRound };
  }

  const allowed = decideHeuristicHandoff(input);
  if (allowed.decision !== "dispatch" || !allowed.nextAction) {
    return {
      decision: "stop",
      reason: `agent planner requested ${plannerDecision.nextAction}, but policy disallows handoff: ${allowed.reason}`,
      nextRound,
    };
  }
  if (plannerDecision.nextAction !== allowed.nextAction) {
    return {
      decision: "stop",
      reason: `agent planner requested ${plannerDecision.nextAction}, but policy only allows ${allowed.nextAction}`,
      nextRound,
    };
  }

  return {
    ...allowed,
    reason: `agent planner selected ${allowed.nextAction}: ${plannerDecision.reason}`,
    handoffContext: plannerDecision.handoffContext,
  };
}

export function decideHandoff(input: HandoffInput): HandoffDecision {
  const nextRound = input.currentRound + 1;
  const automationMode = normalizeAutomationMode(input.automationMode);
  if (automationMode === "disabled") {
    return { decision: "skip", reason: "automation mode is disabled", nextRound };
  }
  if (input.currentRound >= input.maxRounds) {
    return { decision: "stop", reason: "automation round budget exhausted", nextRound };
  }
  if (automationMode === "agent") {
    return decideAgentHandoff(input);
  }
  return decideHeuristicHandoff(input);
}
