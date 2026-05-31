import { extractJsonObject } from "./response.js";

export const AGENT_STATUS_LABEL = "agent";

export type FollowupIntentMode = "disabled" | "agent-label";
export type FollowupIntentOutcome = "respond" | "ignore";

export interface FollowupIntentDecision {
  outcome: FollowupIntentOutcome;
  confidence: string;
  summary: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

export function parseFollowupIntentMode(raw: string | undefined): FollowupIntentMode {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized || normalized === "agent-label") {
    return "agent-label";
  }
  if (normalized === "disabled" || normalized === "false") {
    return "disabled";
  }
  throw new Error(
    `AGENT_FOLLOWUP_INTENT_MODE must be one of: agent-label, disabled (or false); got ${normalized}`,
  );
}

function labelName(label: unknown): string {
  if (!label) {
    return "";
  }
  if (typeof label === "string") {
    return label;
  }
  if (typeof label === "object" && "name" in label) {
    return String((label as { name?: unknown }).name || "");
  }
  return "";
}

function labelsForImplicitFollowupTarget(eventName: string, payload: Payload): unknown[] {
  if (eventName === "issue_comment") {
    return Array.isArray(payload.issue?.labels) ? payload.issue.labels : [];
  }
  if (eventName === "pull_request_review" || eventName === "pull_request_review_comment") {
    return Array.isArray(payload.pull_request?.labels) ? payload.pull_request.labels : [];
  }
  return [];
}

export function hasAgentStatusLabel(eventName: string, payload: Payload): boolean {
  return labelsForImplicitFollowupTarget(eventName, payload).some(
    (label) => labelName(label).trim().toLowerCase() === AGENT_STATUS_LABEL,
  );
}

export function isSupportedImplicitFollowupEvent(eventName: string, payload: Payload): boolean {
  const action = String(payload.action || "").trim().toLowerCase();
  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    return action === "created";
  }
  if (eventName === "pull_request_review") {
    return action === "submitted";
  }
  return false;
}

export function shouldConsiderImplicitFollowup(
  eventName: string,
  payload: Payload,
  mode: FollowupIntentMode,
): boolean {
  return (
    mode === "agent-label" &&
    isSupportedImplicitFollowupEvent(eventName, payload) &&
    hasAgentStatusLabel(eventName, payload)
  );
}

export function normalizeFollowupIntent(raw: string): FollowupIntentDecision {
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error("Follow-up intent output was empty");
  }

  const jsonStr = extractJsonObject(text);
  if (!jsonStr) {
    throw new Error("Follow-up intent output did not contain a JSON object");
  }

  const payload = JSON.parse(jsonStr) as Record<string, unknown>;
  const outcome = String(payload.outcome || payload.intent || "").trim().toLowerCase();
  if (outcome !== "respond" && outcome !== "ignore") {
    throw new Error(`Unsupported follow-up intent outcome: ${outcome || "missing"}`);
  }

  return {
    outcome,
    confidence: String(payload.confidence || "").trim().toLowerCase(),
    summary: String(payload.summary || "").trim(),
  };
}
