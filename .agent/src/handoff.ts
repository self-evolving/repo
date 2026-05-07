import { extractJsonObject } from "./response.js";

export type AgentAction = "implement" | "review" | "fix-pr" | "agent-self-approve";
export type HandoffDecisionKind = "dispatch" | "delegate_issue" | "stop" | "skip";
export type AutomationMode = "disabled" | "heuristics" | "agent";
export type HandoffMarkerState = "pending" | "dispatched" | "failed";
export type PlannerDecisionKind = "handoff" | "delegate_issue" | "stop" | "blocked";

export interface HandoffInput {
  automationMode: string;
  sourceAction: string;
  sourceConclusion: string;
  sourceHandoffContext?: string;
  targetKind?: string;
  targetNumber: string;
  nextTargetNumber?: string;
  currentRound: number;
  maxRounds: number;
  selfApproveEnabled?: boolean;
  plannerDecision?: PlannerDecision | null;
}

export interface HandoffDecision {
  decision: HandoffDecisionKind;
  nextAction?: AgentAction;
  targetNumber?: string;
  reason: string;
  nextRound: number;
  handoffContext?: string;
  plannerDecisionKind?: PlannerDecisionKind;
  userMessage?: string;
  clarificationRequest?: string;
  childStage?: string;
  childInstructions?: string;
  childIssueNumber?: string;
  baseBranch?: string;
  basePr?: string;
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
  userMessage?: string;
  clarificationRequest?: string;
  childStage?: string;
  childInstructions?: string;
  childIssueNumber?: string;
  baseBranch?: string;
  basePr?: string;
}

const REVIEW_TO_FIX_PR = new Set(["minor_issues", "needs_rework", "changes_requested"]);
const HANDOFF_MARKER_PREFIX = "sepo-agent-handoff";
const DEFAULT_FIX_PR_HANDOFF_CONTEXT = [
  "Address only the latest unresolved review synthesis action items.",
  "Ignore optional INFO notes, metadata-only polish, already-fixed findings, and human-judgment nits unless required by the selected fix.",
].join(" ");
const ANY_HANDOFF_MARKER_RE = new RegExp(
  `<!--\\s*${HANDOFF_MARKER_PREFIX}(?:\\s+state:(pending|dispatched|failed))?(?:\\s+created:(\\d+))?\\s+base64:[A-Za-z0-9_-]+\\s*-->`,
  "i",
);

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
  if (normalized === "approved") return "approved";
  if (normalized === "request_changes") return "request_changes";
  if (normalized === "blocked") return "blocked";
  return normalized || "unknown";
}

export function formatMarkdownTableCell(value: string | number): string {
  return String(value)
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim() || " ";
}

export function formatTransposedMarkdownTable(headers: string[], values: Array<string | number>): string[] {
  return [
    `| ${headers.map(formatMarkdownTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    `| ${values.map(formatMarkdownTableCell).join(" | ")} |`,
  ];
}

export function defaultFixPrHandoffContext(): string {
  return DEFAULT_FIX_PR_HANDOFF_CONTEXT;
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const lines = String(markdown || "").split(/\r?\n/);
  const wanted = normalizeToken(heading);
  const section: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      if (inSection) break;
      inSection = normalizeToken(headingMatch[1]) === wanted;
      continue;
    }
    if (inSection) section.push(line);
  }
  return section.join("\n").trim();
}

function normalizeReviewActionItem(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .trim();
}

export function extractReviewActionItems(markdown: string): string[] {
  const section = extractMarkdownSection(markdown, "Action Items");
  if (!section) return [];
  const items: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const checkbox = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (checkbox) {
      if (checkbox[1].trim()) continue;
      const item = normalizeReviewActionItem(checkbox[2]);
      if (item) items.push(item);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet) {
      const item = normalizeReviewActionItem(bullet[1]);
      if (item) items.push(item);
    }
  }
  return items;
}

export function buildReviewFixPrHandoffContext(markdown: string): string {
  const items = extractReviewActionItems(markdown).slice(0, 5);
  if (!items.length) return defaultFixPrHandoffContext();
  return [
    "Address only the latest review synthesis action items:",
    ...items.map((item) => `- ${item}`),
    "",
    "Constraints: Ignore optional INFO notes, metadata-only polish, already-fixed findings, and human-judgment nits unless required by those action items.",
  ].join("\n");
}

function resolveFixPrHandoffContext(input: HandoffInput): string {
  return String(input.sourceHandoffContext || "").trim() || defaultFixPrHandoffContext();
}

function normalizeAgentAction(value: string): AgentAction | null {
  const normalized = normalizeToken(value);
  if (normalized === "implement") return "implement";
  if (normalized === "review") return "review";
  if (normalized === "fix_pr") return "fix-pr";
  if (normalized === "agent_self_approve") return "agent-self-approve";
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
    : decisionToken === "delegate_issue"
      ? "delegate_issue"
    : decisionToken === "stop"
      ? "stop"
      : decisionToken === "blocked"
        ? "blocked"
        : null;
  if (!decision) return null;

  const nextAction = normalizeAgentAction(String(record.next_action ?? record.nextAction ?? ""));
  const reason = String(record.reason || "").trim();
  const handoffContext = String(record.handoff_context ?? record.handoffContext ?? "").trim();
  const userMessage = String(record.user_message ?? record.userMessage ?? "").trim();
  const clarificationRequest = String(
    record.clarification_request ?? record.clarificationRequest ?? "",
  ).trim();
  const childStage = String(record.child_stage ?? record.childStage ?? record.stage ?? "").trim();
  const childInstructions = String(
    record.child_instructions ?? record.childInstructions ?? record.task_instructions ?? record.taskInstructions ?? "",
  ).trim();
  const childIssueNumber = String(
    record.child_issue_number ?? record.childIssueNumber ?? record.target_issue_number ?? record.targetIssueNumber ?? "",
  ).trim();
  const baseBranch = String(record.base_branch ?? record.baseBranch ?? "").trim();
  const basePr = String(record.base_pr ?? record.basePr ?? "").trim();
  const plannerDecision: PlannerDecision = {
    decision,
    nextAction: nextAction || undefined,
    reason: reason || "agent planner returned no reason",
  };
  if (handoffContext) {
    plannerDecision.handoffContext = handoffContext;
  }
  if (userMessage) plannerDecision.userMessage = userMessage;
  if (clarificationRequest) plannerDecision.clarificationRequest = clarificationRequest;
  if (childStage) plannerDecision.childStage = childStage;
  if (childInstructions) plannerDecision.childInstructions = childInstructions;
  if (childIssueNumber) plannerDecision.childIssueNumber = childIssueNumber;
  if (baseBranch) plannerDecision.baseBranch = baseBranch;
  if (basePr) plannerDecision.basePr = basePr;
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

export function parseAnyHandoffMarker(body: string): HandoffMarkerInfo | null {
  const match = String(body || "").match(ANY_HANDOFF_MARKER_RE);
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

export function hasAnyHandoffMarker(body: string): boolean {
  return parseAnyHandoffMarker(body) !== null;
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
  targetKind?: string;
  targetNumber?: string | number;
  nextRound: number;
  maxRounds: number;
  reason: string;
  handoffContext?: string;
  error?: string;
  createdAtMs?: number;
}): string {
  const state = args.state || "dispatched";
  const status = state === "pending"
    ? "pending"
    : state === "failed"
      ? "failed"
      : "dispatched";
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  const normalizedTargetKind = normalizeToken(args.targetKind || "");
  const targetLabel = args.targetNumber
    ? `${normalizedTargetKind === "issue" ? "Issue" : "PR"} #${args.targetNumber}`
    : "Unknown";
  const lines = [
    status === "failed"
      ? "Sepo could not dispatch follow-up automation."
      : status === "pending"
        ? "Sepo is preparing follow-up automation."
        : "Sepo is dispatching follow-up automation.",
    "",
    ...formatTransposedMarkdownTable(
      ["Source", "Next", "Target", "Round", "Status"],
      [args.sourceAction, args.nextAction, targetLabel, `${args.nextRound} / ${args.maxRounds}`, statusLabel],
    ),
    "",
    `Reason: ${args.reason}`,
  ];

  if (normalizeToken(args.nextAction) === "fix_pr") {
    lines.push(
      "",
      "Task for fix-pr:",
      String(args.handoffContext || "").trim() || defaultFixPrHandoffContext(),
    );
  }

  if (args.error) {
    lines.push("", `Dispatch error: ${args.error}`);
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
      return {
        decision: "stop",
        reason: `fix-pr concluded ${conclusion}; no automatic handoff was dispatched because fix-pr must succeed before re-review`,
        nextRound,
      };
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
      if (input.selfApproveEnabled) {
        return {
          decision: "dispatch",
          nextAction: "agent-self-approve",
          targetNumber: nextTarget,
          reason: "review verdict is SHIP; dispatching self-approval gate",
          nextRound,
        };
      }
      return { decision: "stop", reason: "review verdict is SHIP", nextRound };
    }
    if (REVIEW_TO_FIX_PR.has(conclusion)) {
      return {
        decision: "dispatch",
        nextAction: "fix-pr",
        targetNumber: nextTarget,
        reason: `review verdict is ${conclusion}; dispatching fix-pr`,
        nextRound,
        handoffContext: resolveFixPrHandoffContext(input),
      };
    }
    return { decision: "stop", reason: `review verdict ${conclusion} has no handoff`, nextRound };
  }

  if (sourceAction === "agent_self_approve") {
    if (conclusion === "approved") {
      return { decision: "stop", reason: "self-approval approved the pull request", nextRound };
    }
    if (conclusion === "request_changes" || conclusion === "changes_requested") {
      return {
        decision: "dispatch",
        nextAction: "fix-pr",
        targetNumber: nextTarget,
        reason: "self-approval requested follow-up changes; dispatching fix-pr",
        nextRound,
        handoffContext: resolveFixPrHandoffContext(input),
      };
    }
    return { decision: "stop", reason: `self-approval concluded ${conclusion}`, nextRound };
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
      plannerDecisionKind: plannerDecision.decision,
      userMessage: plannerDecision.userMessage,
      clarificationRequest: plannerDecision.clarificationRequest,
    };
  }
  if (plannerDecision.decision === "delegate_issue") {
    const sourceAction = normalizeToken(input.sourceAction);
    const targetKind = normalizeToken(input.targetKind || "");
    if (plannerDecision.nextAction) {
      return { decision: "stop", reason: "delegate_issue must not set next_action", nextRound };
    }
    if (sourceAction !== "orchestrate") {
      return { decision: "stop", reason: "delegate_issue is only allowed from meta orchestration", nextRound };
    }
    if (targetKind && targetKind !== "issue") {
      return { decision: "stop", reason: "meta orchestration can delegate child issues only from issues", nextRound };
    }
    if (plannerDecision.baseBranch && plannerDecision.basePr) {
      return { decision: "stop", reason: "agent planner set both base_branch and base_pr", nextRound };
    }
    if (!plannerDecision.childIssueNumber && !plannerDecision.childInstructions && !plannerDecision.handoffContext) {
      return {
        decision: "stop",
        reason: "agent planner requested child issue delegation without child instructions or existing issue",
        nextRound,
      };
    }
    return {
      decision: "delegate_issue",
      reason: `agent planner selected child issue delegation: ${plannerDecision.reason}`,
      nextRound,
      targetNumber: plannerDecision.childIssueNumber || input.targetNumber,
      handoffContext: plannerDecision.handoffContext,
      childStage: plannerDecision.childStage || `stage-${nextRound - 1}`,
      childInstructions: plannerDecision.childInstructions || plannerDecision.handoffContext,
      childIssueNumber: plannerDecision.childIssueNumber,
      baseBranch: plannerDecision.baseBranch,
      basePr: plannerDecision.basePr,
    };
  }
  if (!plannerDecision.nextAction) {
    return { decision: "stop", reason: "agent planner requested handoff without next_action", nextRound };
  }

  const sourceAction = normalizeToken(input.sourceAction);
  const targetKind = normalizeToken(input.targetKind || "");
  if (sourceAction === "orchestrate" && plannerDecision.nextAction === "implement") {
    if (targetKind && targetKind !== "issue") {
      return { decision: "stop", reason: "issue orchestration can dispatch implement only for issue targets", nextRound };
    }
    if (plannerDecision.baseBranch && plannerDecision.basePr) {
      return { decision: "stop", reason: "agent planner set both base_branch and base_pr", nextRound };
    }
    return {
      decision: "dispatch",
      nextAction: "implement",
      targetNumber: input.targetNumber,
      reason: `agent planner selected implement: ${plannerDecision.reason}`,
      nextRound,
      handoffContext: plannerDecision.handoffContext,
      baseBranch: plannerDecision.baseBranch,
      basePr: plannerDecision.basePr,
    };
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
    handoffContext: plannerDecision.handoffContext || allowed.handoffContext,
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
