// CLI: post-action handoff orchestrator.
// Env: AUTOMATION_MODE, SOURCE_ACTION, SOURCE_CONCLUSION, TARGET_NUMBER,
//      NEXT_TARGET_NUMBER, AUTOMATION_CURRENT_ROUND, AUTOMATION_MAX_ROUNDS,
//      GITHUB_REPOSITORY, DEFAULT_BRANCH, REQUESTED_BY, REQUEST_TEXT,
//      SESSION_BUNDLE_MODE, SOURCE_RUN_ID, PLANNER_RESPONSE_FILE, TARGET_KIND,
//      BASE_BRANCH, BASE_PR, AGENT_COLLAPSE_OLD_REVIEWS

import { readFileSync } from "node:fs";
import {
  getAllowedAssociationsForRoute,
  isAssociationAllowedForRoute,
  isKnownAuthorAssociation,
  parseAccessPolicy,
} from "../access-policy.js";
import { dispatchWorkflow, gh } from "../github.js";
import { setOutput } from "../output.js";
import {
  type HandoffDecision,
  type HandoffMarkerInfo,
  buildHandoffDedupeKey,
  decideHandoff,
  formatHandoffMarkerComment,
  isPendingHandoffMarkerStale,
  normalizeAutomationMode,
  parsePlannerDecision,
  parseHandoffMarker,
} from "../handoff.js";
import { collapsePreviousHandoffComments } from "../review-summary-minimize.js";

interface CommentRecord {
  id?: string | number;
  body?: string;
}

interface HandoffMarkerRecord extends HandoffMarkerInfo {
  id: string;
}

const PENDING_MARKER_TTL_MS = 60 * 60 * 1000;

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveTargetNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function errorText(err: unknown): string {
  const record = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [record.message, record.stderr, record.stdout]
    .map((part) => {
      if (Buffer.isBuffer(part)) return part.toString("utf8");
      return typeof part === "string" ? part : "";
    })
    .filter(Boolean)
    .join("\n") || String(err);
}

function normalizeCommentRecord(value: unknown): CommentRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return { id: record.id as string | number | undefined, body: String(record.body || "") };
}

function fetchIssueComments(repo: string, issueNumber: number): CommentRecord[] {
  const raw = gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/issues/${issueNumber}/comments`,
  ]).trim();
  if (!raw) return [];

  const parsed = JSON.parse(raw) as unknown;
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const comments: CommentRecord[] = [];
  for (const page of pages) {
    const entries = Array.isArray(page) ? page : [page];
    for (const entry of entries) {
      const comment = normalizeCommentRecord(entry);
      if (comment) comments.push(comment);
    }
  }
  return comments;
}

function findHandoffMarkers(
  repo: string,
  issueNumber: number,
  dedupeKey: string,
): HandoffMarkerRecord[] {
  return fetchIssueComments(repo, issueNumber)
    .map((comment) => {
      const parsed = parseHandoffMarker(comment.body || "", dedupeKey);
      if (!parsed) return null;
      return {
        id: String(comment.id || ""),
        ...parsed,
      };
    })
    .filter((marker): marker is HandoffMarkerRecord => Boolean(marker?.id));
}

function createIssueComment(repo: string, issueNumber: number, body: string): string {
  return gh([
    "api",
    "--method",
    "POST",
    `repos/${repo}/issues/${issueNumber}/comments`,
    "-f",
    `body=${body}`,
    "--jq",
    ".id",
  ]).trim();
}

function updateIssueComment(repo: string, commentId: string, body: string): void {
  gh([
    "api",
    "--method",
    "PATCH",
    `repos/${repo}/issues/comments/${commentId}`,
    "-f",
    `body=${body}`,
  ]);
}

const repo = process.env.GITHUB_REPOSITORY || "";
const ref = process.env.DEFAULT_BRANCH || "";
const sourceAction = process.env.SOURCE_ACTION || "";
const sourceConclusion = process.env.SOURCE_CONCLUSION || "unknown";
const sourceRunId = process.env.SOURCE_RUN_ID || process.env.GITHUB_RUN_ID || "";
const sourceTargetKind = process.env.TARGET_KIND || "";
const sourceAssociationRaw = process.env.AUTHOR_ASSOCIATION || "";
const accessPolicyRaw = process.env.ACCESS_POLICY || "";
const isPublicRepo = String(process.env.REPOSITORY_PRIVATE || "").trim().toLowerCase() === "false";
const targetNumber = process.env.TARGET_NUMBER || "";
const requestedBy = process.env.REQUESTED_BY || "";
const requestText = process.env.REQUEST_TEXT || "";
const sessionBundleMode = process.env.SESSION_BUNDLE_MODE || "";
const baseBranch = process.env.BASE_BRANCH || "";
const basePr = process.env.BASE_PR || "";
const maxRounds = positiveInt(process.env.AUTOMATION_MAX_ROUNDS || "", 5);
const currentRound = positiveInt(process.env.AUTOMATION_CURRENT_ROUND || "", 1);
const automationMode = normalizeAutomationMode(process.env.AUTOMATION_MODE || "disabled");
const collapseOldReviews = !["false", "0", "no", "off"].includes(
  (process.env.AGENT_COLLAPSE_OLD_REVIEWS || "").trim().toLowerCase(),
);

function readPlannerDecision(): ReturnType<typeof parsePlannerDecision> {
  const responseFile = process.env.PLANNER_RESPONSE_FILE || "";
  if (!responseFile) return null;
  try {
    return parsePlannerDecision(readFileSync(responseFile, "utf8"));
  } catch {
    return null;
  }
}

function normalizeToken(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function readPrStatus(repoSlug: string, prNumber: string): { state: string; reviewDecision: string } | null {
  try {
    const raw = gh([
      "pr",
      "view",
      prNumber,
      "--repo",
      repoSlug,
      "--json",
      "state,reviewDecision",
    ]).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      state: String(parsed.state || "").trim().toUpperCase(),
      reviewDecision: String(parsed.reviewDecision || "").trim().toUpperCase(),
    };
  } catch {
    return null;
  }
}

function decideManualOrchestration(): HandoffDecision {
  const nextRound = currentRound + 1;
  if (currentRound >= maxRounds) {
    return { decision: "stop", reason: "automation round budget exhausted", nextRound };
  }

  const normalizedKind = normalizeToken(sourceTargetKind);
  if (normalizedKind === "issue") {
    return {
      decision: "dispatch",
      nextAction: "implement",
      targetNumber,
      reason: "manual orchestrate start on issue; dispatching implement",
      nextRound,
    };
  }

  if (normalizedKind === "pull_request") {
    const status = readPrStatus(repo, targetNumber);
    if (!status) {
      return { decision: "stop", reason: "could not read pull request status", nextRound };
    }
    if (status.state !== "OPEN") {
      return { decision: "stop", reason: `pull request is ${status.state.toLowerCase()}`, nextRound };
    }
    if (status.reviewDecision === "CHANGES_REQUESTED") {
      return {
        decision: "dispatch",
        nextAction: "fix-pr",
        targetNumber,
        reason: "manual orchestrate start on PR with CHANGES_REQUESTED; dispatching fix-pr",
        nextRound,
      };
    }
    return {
      decision: "dispatch",
      nextAction: "review",
      targetNumber,
      reason: "manual orchestrate start on PR; dispatching review",
      nextRound,
    };
  }

  return { decision: "stop", reason: `unsupported target kind ${sourceTargetKind || "missing"}`, nextRound };
}

function applyDelegatedRouteAuthorization(decision: HandoffDecision): HandoffDecision {
  if (normalizeToken(sourceAction) !== "orchestrate" || decision.decision !== "dispatch" || !decision.nextAction) {
    return decision;
  }

  let policy;
  try {
    policy = parseAccessPolicy(accessPolicyRaw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { decision: "stop", reason: `invalid AGENT_ACCESS_POLICY: ${msg}`, nextRound: decision.nextRound };
  }

  const association = isKnownAuthorAssociation(sourceAssociationRaw) ? sourceAssociationRaw : "NONE";
  if (isAssociationAllowedForRoute(policy, decision.nextAction, association, isPublicRepo)) {
    return decision;
  }

  const allowed = getAllowedAssociationsForRoute(policy, decision.nextAction, isPublicRepo);
  return {
    decision: "stop",
    reason: `${decision.nextAction} requests currently require ${allowed.join(", ")} access.`,
    nextRound: decision.nextRound,
  };
}

const routeDecision = normalizeToken(sourceAction) === "orchestrate"
  ? decideManualOrchestration()
  : decideHandoff({
    automationMode,
    sourceAction,
    sourceConclusion,
    targetNumber,
    nextTargetNumber: process.env.NEXT_TARGET_NUMBER || "",
    currentRound,
    maxRounds,
    plannerDecision: automationMode === "agent" ? readPlannerDecision() : null,
  });
const decision = applyDelegatedRouteAuthorization(routeDecision);

setOutput("decision", decision.decision);
setOutput("next_action", decision.nextAction || "");
setOutput("target_number", decision.targetNumber || "");
setOutput("reason", decision.reason);
setOutput("next_round", String(decision.nextRound));
setOutput("handoff_context", decision.handoffContext || "");
setOutput("deduped", "false");
setOutput("dedupe_key", "");
setOutput("marker_comment_id", "");

if (decision.decision !== "dispatch") {
  console.log(`Handoff ${decision.decision}: ${decision.reason}`);
  process.exit(0);
}

if (!repo || !ref || !decision.nextAction || !decision.targetNumber) {
  console.error("Missing required dispatch context for handoff");
  process.exit(2);
}

const dedupeKey = buildHandoffDedupeKey({
  repo,
  sourceRunId,
  sourceAction,
  sourceTargetNumber: targetNumber,
  nextAction: decision.nextAction,
  nextTargetNumber: decision.targetNumber,
  nextRound: decision.nextRound,
});
setOutput("dedupe_key", dedupeKey);

const markerTargetNumber = parsePositiveTargetNumber(decision.targetNumber);
if (!markerTargetNumber) {
  console.error(`Invalid handoff marker target number: ${decision.targetNumber}`);
  process.exit(2);
}

const existingMarkers = findHandoffMarkers(repo, markerTargetNumber, dedupeKey);
const nowMs = Date.now();
const activeMarker = existingMarkers.find((marker) => (
  marker.state === "dispatched" ||
  (marker.state === "pending" && !isPendingHandoffMarkerStale(marker, nowMs, PENDING_MARKER_TTL_MS))
));
if (activeMarker) {
  setOutput("deduped", "true");
  setOutput("marker_comment_id", activeMarker.id);
  console.log(`Skipping duplicate handoff ${dedupeKey} (${activeMarker.state})`);
  process.exit(0);
}

for (const staleMarker of existingMarkers.filter((marker) =>
  isPendingHandoffMarkerStale(marker, nowMs, PENDING_MARKER_TTL_MS)
)) {
  try {
    updateIssueComment(repo, staleMarker.id, formatHandoffMarkerComment({
      key: dedupeKey,
      state: "failed",
      sourceAction,
      nextAction: decision.nextAction,
      nextRound: decision.nextRound,
      maxRounds,
      reason: decision.reason,
      error: "Pending handoff marker expired before dispatch completed; retrying handoff.",
    }));
  } catch (err: unknown) {
    console.warn(`Failed to expire stale pending handoff marker ${staleMarker.id}: ${errorText(err)}`);
  }
}

const pendingBody = formatHandoffMarkerComment({
  key: dedupeKey,
  state: "pending",
  sourceAction,
  nextAction: decision.nextAction,
  nextRound: decision.nextRound,
  maxRounds,
  reason: decision.reason,
  createdAtMs: nowMs,
});
const markerCommentId = createIssueComment(repo, markerTargetNumber, pendingBody);
setOutput("marker_comment_id", markerCommentId);

const commonInputs = {
  requested_by: requestedBy,
  request_text: requestText,
  orchestration_enabled: "true",
  automation_mode: automationMode === "disabled" ? "heuristics" : automationMode,
  automation_current_round: String(decision.nextRound),
  automation_max_rounds: String(maxRounds),
  session_bundle_mode: sessionBundleMode,
};

try {
  if (decision.nextAction === "review") {
    dispatchWorkflow(repo, "agent-review.yml", ref, {
      ...commonInputs,
      pr_number: decision.targetNumber,
    });
  } else if (decision.nextAction === "implement") {
    dispatchWorkflow(repo, "agent-implement.yml", ref, {
      ...commonInputs,
      issue_number: decision.targetNumber,
      approval_comment_url: "",
      base_branch: baseBranch,
      base_pr: basePr,
      implementation_route: "implement",
      implementation_prompt: "implement",
    });
  } else if (decision.nextAction === "fix-pr") {
    dispatchWorkflow(repo, "agent-fix-pr.yml", ref, {
      ...commonInputs,
      pr_number: decision.targetNumber,
      request_source_kind: "workflow_dispatch",
      orchestrator_context: decision.handoffContext || "",
    });
  } else {
    console.error(`Unsupported next action: ${decision.nextAction}`);
    process.exit(2);
  }
} catch (err: unknown) {
  const message = errorText(err).slice(0, 1000);
  try {
    updateIssueComment(repo, markerCommentId, formatHandoffMarkerComment({
      key: dedupeKey,
      state: "failed",
      sourceAction,
      nextAction: decision.nextAction,
      nextRound: decision.nextRound,
      maxRounds,
      reason: decision.reason,
      error: message,
    }));
  } catch (updateErr: unknown) {
    console.warn(`Failed to mark handoff ${dedupeKey} as failed: ${errorText(updateErr)}`);
  }
  throw err;
}

const dispatchedBody = formatHandoffMarkerComment({
  key: dedupeKey,
  state: "dispatched",
  sourceAction,
  nextAction: decision.nextAction,
  nextRound: decision.nextRound,
  maxRounds,
  reason: decision.reason,
  createdAtMs: nowMs,
});

try {
  updateIssueComment(repo, markerCommentId, dispatchedBody);
} catch (err: unknown) {
  console.warn(`Handoff dispatched but marker ${markerCommentId} remained pending: ${errorText(err)}`);
}

if (collapseOldReviews) {
  try {
    const collapsed = collapsePreviousHandoffComments({
      repo,
      targetNumber: markerTargetNumber,
      targetKind: decision.nextAction === "implement" ? "issue" : "pull_request",
      excludeCommentId: markerCommentId,
      currentCreatedAtMs: nowMs,
    });
    if (collapsed > 0) {
      console.log(`Collapsed ${collapsed} previous orchestrator handoff comment(s).`);
    }
  } catch (err: unknown) {
    console.warn(
      `Failed to collapse previous orchestrator handoff comments for ${repo}#${markerTargetNumber}: ${errorText(err)}`,
    );
  }
}

console.log(`Handoff dispatched ${decision.nextAction} for #${decision.targetNumber}: ${decision.reason}`);
