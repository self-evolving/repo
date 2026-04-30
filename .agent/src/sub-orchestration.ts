export type SubOrchestratorState = "running" | "done" | "blocked" | "failed";

export interface SubOrchestratorMarker {
  parent: number;
  stage: string;
  state: SubOrchestratorState;
}

const MARKER_PREFIX = "sepo-sub-orchestrator";
const MARKER_RE = /<!--\s*sepo-sub-orchestrator\s+parent:(\d+)\s+stage:([^\s]+)\s+state:(running|done|blocked|failed)\s*-->/i;

function normalizeStage(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "stage";
}

export function formatSubOrchestratorMarker(input: {
  parent: number;
  stage: string;
  state?: SubOrchestratorState;
}): string {
  return `<!-- ${MARKER_PREFIX} parent:${input.parent} stage:${normalizeStage(input.stage)} state:${input.state || "running"} -->`;
}

export function parseSubOrchestratorMarker(body: string): SubOrchestratorMarker | null {
  const match = String(body || "").match(MARKER_RE);
  if (!match) return null;
  return {
    parent: Number.parseInt(match[1], 10),
    stage: match[2],
    state: match[3].toLowerCase() as SubOrchestratorState,
  };
}

export function updateSubOrchestratorMarkerState(body: string, state: SubOrchestratorState): string {
  const marker = parseSubOrchestratorMarker(body);
  if (!marker) return body;
  return String(body || "").replace(MARKER_RE, formatSubOrchestratorMarker({ ...marker, state }));
}

export function formatSubOrchestrationIssueBody(input: {
  parentIssue: number;
  stage: string;
  taskInstructions: string;
  baseBranch?: string;
  basePr?: string;
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

  lines.push("", formatSubOrchestratorMarker({ parent: input.parentIssue, stage: input.stage }));
  return lines.join("\n");
}

export function extractClosingIssueNumber(text: string): number | null {
  const match = String(text || "").match(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/i,
  );
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
  if (reason.includes("blocked") || reason.includes("policy") || reason.includes("malformed")) return "blocked";
  return "failed";
}
