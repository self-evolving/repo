export type SubOrchestratorState = "running" | "done" | "blocked" | "failed";

export interface SubOrchestratorMarker {
  parent: number;
  stage: string;
  state: SubOrchestratorState;
  parentRound?: number;
}

export interface SubOrchestratorChildLink {
  parent: number;
  stage: string;
  child: number;
}

const MARKER_PREFIX = "sepo-sub-orchestrator";
const MARKER_RE = /<!--\s*sepo-sub-orchestrator\s+([\s\S]*?)-->/i;
const CHILD_LINK_MARKER_PREFIX = "sepo-sub-orchestrator-child";
const CHILD_LINK_MARKER_RE = /<!--\s*sepo-sub-orchestrator-child\s+([\s\S]*?)-->/i;
const VALID_STATES = new Set<SubOrchestratorState>(["running", "done", "blocked", "failed"]);

export function normalizeSubOrchestratorStage(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "stage";
}

function parseMarkerTokens(text: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of String(text || "").matchAll(/\b([a-z_]+):([^\s]+)/gi)) {
    tokens.set(match[1].toLowerCase(), match[2]);
  }
  return tokens;
}

function parsePositiveInteger(value: string | undefined): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function formatSubOrchestratorMarker(input: {
  parent: number;
  stage: string;
  state?: SubOrchestratorState;
  parentRound?: number;
}): string {
  const parts = [
    MARKER_PREFIX,
    `parent:${input.parent}`,
    `stage:${normalizeSubOrchestratorStage(input.stage)}`,
    `state:${input.state || "running"}`,
  ];
  const parentRound = parsePositiveInteger(String(input.parentRound || ""));
  if (parentRound) parts.push(`parent_round:${parentRound}`);
  return `<!-- ${parts.join(" ")} -->`;
}

export function parseSubOrchestratorMarker(body: string): SubOrchestratorMarker | null {
  const match = String(body || "").match(MARKER_RE);
  if (!match) return null;

  const tokens = parseMarkerTokens(match[1] || "");
  const parent = parsePositiveInteger(tokens.get("parent"));
  const stageToken = tokens.get("stage");
  const stage = stageToken ? normalizeSubOrchestratorStage(stageToken) : "";
  const rawState = String(tokens.get("state") || "").toLowerCase() as SubOrchestratorState;
  if (!parent || !stage || !VALID_STATES.has(rawState)) return null;

  const parentRound = parsePositiveInteger(tokens.get("parent_round"));
  return {
    parent,
    stage,
    state: rawState,
    ...(parentRound ? { parentRound } : {}),
  };
}

export function formatSubOrchestratorChildLinkMarker(input: {
  parent: number;
  stage: string;
  child: number;
}): string {
  return `<!-- ${CHILD_LINK_MARKER_PREFIX} parent:${input.parent} stage:${normalizeSubOrchestratorStage(input.stage)} child:${input.child} -->`;
}

export function parseSubOrchestratorChildLinkMarker(body: string): SubOrchestratorChildLink | null {
  const match = String(body || "").match(CHILD_LINK_MARKER_RE);
  if (!match) return null;

  const tokens = parseMarkerTokens(match[1] || "");
  const parent = parsePositiveInteger(tokens.get("parent"));
  const stageToken = tokens.get("stage");
  const stage = stageToken ? normalizeSubOrchestratorStage(stageToken) : "";
  const child = parsePositiveInteger(tokens.get("child"));
  if (!parent || !stage || !child) return null;

  return { parent, stage, child };
}

export function updateSubOrchestratorMarkerState(body: string, state: SubOrchestratorState): string {
  const marker = parseSubOrchestratorMarker(body);
  if (!marker) return body;
  return String(body || "").replace(MARKER_RE, formatSubOrchestratorMarker({ ...marker, state }));
}

export function updateSubOrchestratorMarkerParentRound(body: string, parentRound: number): string {
  const marker = parseSubOrchestratorMarker(body);
  if (!marker) return body;
  return String(body || "").replace(MARKER_RE, formatSubOrchestratorMarker({ ...marker, parentRound }));
}

export function formatSubOrchestrationIssueBody(input: {
  parentIssue: number;
  stage: string;
  taskInstructions: string;
  baseBranch?: string;
  basePr?: string;
  parentRound?: number;
}): string {
  const lines = [
    `Parent issue: #${input.parentIssue}`,
    "",
    `Stage: ${input.stage.trim() || "Sub-orchestration"}`,
    "",
    "## Task",
    "",
    input.taskInstructions.trim() || "Continue the parent orchestration subtask.",
  ];

  if (input.baseBranch || input.basePr) {
    lines.push("", "## Base", "");
    if (input.baseBranch) lines.push(`- base_branch: ${input.baseBranch}`);
    if (input.basePr) lines.push(`- base_pr: #${input.basePr}`);
  }

  lines.push("", formatSubOrchestratorMarker({
    parent: input.parentIssue,
    stage: input.stage,
    parentRound: input.parentRound,
  }));
  return lines.join("\n");
}

function normalizeRepoSlug(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export function extractClosingIssueNumber(text: string, currentRepo = ""): number | null {
  const currentRepoSlug = normalizeRepoSlug(currentRepo);
  const closingRefRe =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|implement(?:s|ed)?)\s+(?:(?<repo>[\w.-]+\/[\w.-]+)#|#)(?<number>\d+)\b/gi;

  for (const match of String(text || "").matchAll(closingRefRe)) {
    const referencedRepo = normalizeRepoSlug(match.groups?.repo || "");
    if (referencedRepo && referencedRepo !== currentRepoSlug) {
      continue;
    }
    if (referencedRepo && !currentRepoSlug) {
      continue;
    }
    const parsed = Number.parseInt(match.groups?.number || "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isAuthorizationStopReason(reason: string): boolean {
  return reason.startsWith("orchestrate requests require ") ||
    /\brequests currently require\b/.test(reason);
}

function isRoundLimitStopReason(reason: string): boolean {
  return reason === "automation round budget exhausted" ||
    reason.includes("round budget exhausted") ||
    reason.includes("round limit") ||
    reason.includes("max rounds") ||
    reason.includes("maximum rounds");
}

export function resultStateFromTerminal(input: {
  sourceAction: string;
  sourceConclusion: string;
  reason: string;
}): SubOrchestratorState {
  const action = input.sourceAction.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const conclusion = input.sourceConclusion.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const reason = input.reason.trim().toLowerCase();
  if (action === "review" && conclusion === "ship") return "done";
  if (
    reason.startsWith("agent planner blocked:") ||
    isAuthorizationStopReason(reason) ||
    isRoundLimitStopReason(reason)
  ) {
    return "blocked";
  }
  return "failed";
}
