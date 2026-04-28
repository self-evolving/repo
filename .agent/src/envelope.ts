// Runtime envelope: the shared metadata contract that every agent route
// receives. Agents use this identity block plus self-serve tool calls
// (gh, git, local file reads) to gather the context they need.

export interface RuntimeEnvelope {
  schema_version: number;
  repo_slug: string;
  route: string;
  source_kind: string;
  target_kind: string;
  target_number: number;
  target_url: string;
  request_text: string;
  requested_by: string;
  approval_comment_url: string | null;
  workflow: string;
  lane: string;
  thread_key: string;
}

export interface EventContext {
  body: string;
  sourceKind: string;
  targetKind: string;
  targetNumber: string;
  targetUrl: string;
}

export interface RuntimeParams {
  repo_slug: string;
  route: string;
  requested_by: string;
  approval_comment_url?: string | null;
  workflow?: string;
  lane?: string;
}

export interface EnvelopeParams {
  repo_slug: string;
  route: string;
  source_kind: string;
  target_kind: string;
  target_number: number;
  target_url: string;
  request_text?: string;
  requested_by: string;
  approval_comment_url?: string | null;
  workflow?: string;
  lane?: string;
}

export const SCHEMA_VERSION = 1;
export const DEFAULT_LANE = "default";

export const VALID_ROUTES = new Set([
  "review",
  "implement",
  "fix-pr",
  "answer",
  "create-action",
  "dispatch",
  "orchestrator",
  "skill",
  "rubrics-review",
  "rubrics-initialization",
  "rubrics-update",
]);

export const VALID_SOURCE_KINDS = new Set([
  "issue",
  "issue_comment",
  "pull_request",
  "pull_request_review_comment",
  "pull_request_review",
  "discussion",
  "discussion_comment",
  "workflow_dispatch",
]);

export const VALID_TARGET_KINDS = new Set(["issue", "pull_request", "discussion", "repository"]);

export const REQUIRED_FIELDS = [
  "repo_slug",
  "route",
  "source_kind",
  "target_kind",
  "target_number",
  "target_url",
  "requested_by",
] as const;

export function buildThreadKey(params: {
  repo_slug: string;
  target_kind: string;
  target_number: number;
  route: string;
  lane?: string;
}): string {
  const effectiveLane = String(params.lane || DEFAULT_LANE);
  return `${params.repo_slug}:${params.target_kind}:${params.target_number}:${params.route}:${effectiveLane}`;
}

export function buildEnvelope(params: EnvelopeParams): RuntimeEnvelope {
  const envelope: RuntimeEnvelope = {
    schema_version: SCHEMA_VERSION,
    repo_slug: String(params.repo_slug || ""),
    route: String(params.route || ""),
    source_kind: String(params.source_kind || ""),
    target_kind: String(params.target_kind || ""),
    target_number: Number(params.target_number) || 0,
    target_url: String(params.target_url || ""),
    request_text: String(params.request_text || ""),
    requested_by: String(params.requested_by || ""),
    approval_comment_url: params.approval_comment_url || null,
    workflow: String(params.workflow || ""),
    lane: String(params.lane || DEFAULT_LANE),
    thread_key: "",
  };

  envelope.thread_key = buildThreadKey(envelope);
  return envelope;
}

export function validateEnvelope(envelope: RuntimeEnvelope | null | undefined): string[] {
  const errors: string[] = [];

  if (!envelope || typeof envelope !== "object") {
    return ["Envelope must be a non-null object"];
  }

  if (envelope.schema_version !== SCHEMA_VERSION) {
    errors.push(
      `Unsupported schema_version: ${envelope.schema_version} (expected ${SCHEMA_VERSION})`
    );
  }

  for (const field of REQUIRED_FIELDS) {
    const value = (envelope as unknown as Record<string, unknown>)[field];
    // Repository-scoped runs (scan, sync) have no target_number; 0 is valid.
    const allowZeroTargetNumber = field === "target_number" && envelope.target_kind === "repository";
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (typeof value === "number" && value === 0 && !allowZeroTargetNumber)
    ) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (envelope.route && !VALID_ROUTES.has(envelope.route)) {
    errors.push(`Invalid route: ${envelope.route}`);
  }

  if (envelope.source_kind && !VALID_SOURCE_KINDS.has(envelope.source_kind)) {
    errors.push(`Invalid source_kind: ${envelope.source_kind}`);
  }

  if (envelope.target_kind && !VALID_TARGET_KINDS.has(envelope.target_kind)) {
    errors.push(`Invalid target_kind: ${envelope.target_kind}`);
  }

  return errors;
}

export function buildEnvelopeFromEventContext(
  eventContext: EventContext,
  runtime: RuntimeParams
): RuntimeEnvelope {
  return buildEnvelope({
    repo_slug: runtime.repo_slug,
    route: runtime.route,
    source_kind: eventContext.sourceKind,
    target_kind: eventContext.targetKind,
    target_number: Number(eventContext.targetNumber),
    target_url: eventContext.targetUrl,
    request_text: eventContext.body,
    requested_by: runtime.requested_by,
    approval_comment_url: runtime.approval_comment_url || null,
    workflow: runtime.workflow,
    lane: runtime.lane,
  });
}

export function envelopeToPromptVars(envelope: RuntimeEnvelope): Record<string, string> {
  return {
    REPO_SLUG: envelope.repo_slug,
    ROUTE: envelope.route,
    SOURCE_KIND: envelope.source_kind,
    TARGET_KIND: envelope.target_kind,
    TARGET_NUMBER: String(envelope.target_number),
    TARGET_URL: envelope.target_url,
    REQUEST_TEXT: envelope.request_text,
    MENTION_BODY: envelope.request_text,
    REQUESTED_BY: envelope.requested_by,
    WORKFLOW: envelope.workflow,
    LANE: envelope.lane,
    THREAD_KEY: envelope.thread_key,
  };
}
