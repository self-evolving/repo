// CLI: post-action handoff orchestrator.
// Env: AUTOMATION_MODE, SOURCE_ACTION, SOURCE_CONCLUSION, TARGET_NUMBER,
//      NEXT_TARGET_NUMBER, AUTOMATION_CURRENT_ROUND, AUTOMATION_MAX_ROUNDS,
//      GITHUB_REPOSITORY, DEFAULT_BRANCH, REQUESTED_BY, REQUEST_TEXT,
//      SOURCE_COMMENT_URL,
//      SESSION_BUNDLE_MODE, SOURCE_RUN_ID, PLANNER_RESPONSE_FILE, TARGET_KIND

import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  getAllowedAssociationsForRoute,
  isAssociationAllowedForRoute,
  isKnownAuthorAssociation,
  parseAccessPolicy,
} from "../access-policy.js";
import { createIssue, dispatchWorkflow, gh } from "../github.js";
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

interface CommentRecord {
  id?: string | number;
  body?: string;
}

interface HandoffMarkerRecord extends HandoffMarkerInfo {
  id: string;
}

interface ClosedPrComment {
  prNumber: string;
  body: string;
}

interface ClosedPrFollowupMarkerRecord {
  id: string;
  state: HandoffMarkerInfo["state"];
  createdAtMs: number | null;
  targetNumber: string;
  targetUrl: string;
}

const PENDING_MARKER_TTL_MS = 60 * 60 * 1000;
const CLOSED_PR_FOLLOWUP_MARKER_PREFIX = "sepo-agent-closed-pr-followup";

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

function encodeMarkerKey(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
const sourceCommentUrl = process.env.SOURCE_COMMENT_URL || "";
const sessionBundleMode = process.env.SESSION_BUNDLE_MODE || "";
const maxRounds = positiveInt(process.env.AUTOMATION_MAX_ROUNDS || "", 5);
const currentRound = positiveInt(process.env.AUTOMATION_CURRENT_ROUND || "", 1);
const automationMode = normalizeAutomationMode(process.env.AUTOMATION_MODE || "disabled");
const deferred = { closedPrComment: null as ClosedPrComment | null };

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

function delegatedRouteAuthorizationStop(
  nextAction: NonNullable<HandoffDecision["nextAction"]>,
  nextRound: number,
): HandoffDecision | null {
  let policy;
  try {
    policy = parseAccessPolicy(accessPolicyRaw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { decision: "stop", reason: `invalid AGENT_ACCESS_POLICY: ${msg}`, nextRound };
  }

  const association = isKnownAuthorAssociation(sourceAssociationRaw) ? sourceAssociationRaw : "NONE";
  if (isAssociationAllowedForRoute(policy, nextAction, association, isPublicRepo)) {
    return null;
  }

  const allowed = getAllowedAssociationsForRoute(policy, nextAction, isPublicRepo);
  return {
    decision: "stop",
    reason: `${nextAction} requests currently require ${allowed.join(", ")} access.`,
    nextRound,
  };
}

function normalizeTitle(raw: string): string {
  const collapsed = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > 70 ? `${collapsed.slice(0, 67)}...` : collapsed;
}

function stripAgentCommand(text: string): string {
  return String(text || "")
    .replace(/@[\w-]+(?:\/[\w-]+)?\s+\/orchestrate\b/gi, "")
    .replace(/\bagent\/orchestrate\b/gi, "")
    .replace(/\/orchestrate\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyBranchChangeRequest(text: string): boolean {
  const normalized = stripAgentCommand(text).toLowerCase();
  if (!normalized) return false;
  const hasChangeIntent = /\b(add|adjust|change|create|fix|implement|patch|prefetch|remove|update|write)\b/.test(normalized);
  if (!hasChangeIntent) return false;
  return /\b(code|failing|failure|regression|test|tests?|workflow)\b/.test(normalized) ||
    /\b(fix|implement|patch)\b/.test(normalized);
}

function buildClosedPrFollowupKey(prNumber: string): string {
  const requestIdentity = sourceCommentUrl.trim() || stripAgentCommand(requestText).toLowerCase();
  return [
    "closed-pr-followup",
    repo.trim().toLowerCase(),
    prNumber.trim(),
    requestIdentity,
  ].join(":");
}

function parseClosedPrFollowupMarker(body: string, key: string): Omit<ClosedPrFollowupMarkerRecord, "id"> | null {
  const encoded = escapeRegex(encodeMarkerKey(key));
  const markerRe = new RegExp(
    `<!--\\s*${CLOSED_PR_FOLLOWUP_MARKER_PREFIX}` +
      `(?:\\s+state:(pending|dispatched|failed))?` +
      `(?:\\s+created:(\\d+))?` +
      `(?:\\s+target:(\\d+))?` +
      `(?:\\s+url:(\\S+))?` +
      `\\s+base64:${encoded}\\s*-->`,
    "i",
  );
  const match = String(body || "").match(markerRe);
  if (!match) return null;
  const rawState = String(match[1] || "dispatched").toLowerCase();
  const state: HandoffMarkerInfo["state"] = rawState === "pending" || rawState === "failed"
    ? rawState
    : "dispatched";
  const createdAtMs = match[2] ? Number.parseInt(match[2], 10) : NaN;
  return {
    state,
    createdAtMs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : null,
    targetNumber: String(match[3] || ""),
    targetUrl: String(match[4] || ""),
  };
}

function formatClosedPrFollowupMarkerComment(args: {
  key: string;
  state: HandoffMarkerInfo["state"];
  prNumber: string;
  targetNumber?: string;
  targetUrl?: string;
  error?: string;
  createdAtMs?: number;
}): string {
  const lines = [
    `Sepo closed-PR follow-up ${args.state} for PR #${args.prNumber}.`,
  ];
  if (args.targetUrl) {
    lines.push("", `Follow-up issue: ${args.targetUrl}`);
  }
  if (args.error) {
    lines.push("", `Error: ${args.error}`);
  }

  const markerParts = [
    CLOSED_PR_FOLLOWUP_MARKER_PREFIX,
    `state:${args.state}`,
    `created:${Math.trunc(args.createdAtMs ?? Date.now())}`,
  ];
  if (args.targetNumber) markerParts.push(`target:${args.targetNumber}`);
  if (args.targetUrl) markerParts.push(`url:${args.targetUrl}`);
  markerParts.push(`base64:${encodeMarkerKey(args.key)}`);
  lines.push("", `<!-- ${markerParts.join(" ")} -->`);
  return lines.join("\n");
}

function findClosedPrFollowupMarkers(prNumber: string, key: string): ClosedPrFollowupMarkerRecord[] {
  const issueNumber = parsePositiveTargetNumber(prNumber);
  if (!issueNumber) return [];
  return fetchIssueComments(repo, issueNumber)
    .map((comment) => {
      const parsed = parseClosedPrFollowupMarker(comment.body || "", key);
      if (!parsed) return null;
      return {
        id: String(comment.id || ""),
        ...parsed,
      };
    })
    .filter((marker): marker is ClosedPrFollowupMarkerRecord => Boolean(marker?.id));
}

function createFollowupIssueForClosedPr(prNumber: string): { number: string; url: string } | null {
  const cleanRequest = stripAgentCommand(requestText);
  const sourcePrUrl = `https://github.com/${repo}/pull/${prNumber}`;
  const titleSource = cleanRequest || `Follow-up from PR #${prNumber}`;
  const title = normalizeTitle(`Follow-up from PR #${prNumber}: ${titleSource}`);
  const bodyLines = [
    "## Follow-up request",
    "",
    cleanRequest || requestText.trim() || "_No additional request text was provided._",
    "",
    "## Source",
    "",
    `- PR: ${sourcePrUrl}`,
  ];
  if (sourceCommentUrl.trim()) {
    bodyLines.push(`- Comment: ${sourceCommentUrl.trim()}`);
  }
  bodyLines.push("", "This issue was created by `/orchestrate` because the source PR is no longer open.");

  const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
  const bodyFile = join(runnerTemp, `agent-followup-issue-${randomBytes(8).toString("hex")}.md`);
  writeFileSync(bodyFile, bodyLines.join("\n") + "\n", "utf8");
  const issueUrl = createIssue({ title, bodyFile, repo });
  const numberMatch = issueUrl.match(/\/issues\/(\d+)(?:\D.*)?$/) || issueUrl.match(/(\d+)$/);
  const number = numberMatch ? numberMatch[1] : "";
  if (!number) return null;
  return { number, url: issueUrl };
}

function commentClosedPrFollowup(prNumber: string, body: string): void {
  try {
    createIssueComment(repo, parsePositiveTargetNumber(prNumber), body);
  } catch (err: unknown) {
    console.warn(`Failed to comment on source PR #${prNumber}: ${errorText(err)}`);
  }
}

function persistClosedPrFollowupTarget(args: {
  reservationId: string;
  followupKey: string;
  prNumber: string;
  followup: { number: string; url: string };
  createdAtMs: number;
}): void {
  const markerBody = formatClosedPrFollowupMarkerComment({
    key: args.followupKey,
    state: "pending",
    prNumber: args.prNumber,
    targetNumber: args.followup.number,
    targetUrl: args.followup.url,
    createdAtMs: args.createdAtMs,
  });
  try {
    updateIssueComment(repo, args.reservationId, markerBody);
    return;
  } catch (err: unknown) {
    console.warn(`Failed to update closed-PR follow-up marker ${args.reservationId}: ${errorText(err)}`);
  }

  try {
    createIssueComment(repo, parsePositiveTargetNumber(args.prNumber), markerBody);
  } catch (err: unknown) {
    throw new Error(`created follow-up issue #${args.followup.number}, but failed to persist source marker: ${errorText(err)}`);
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
      if (!isLikelyBranchChangeRequest(requestText)) {
        const reason = `pull request is ${status.state.toLowerCase()}; closed PR follow-up needs a concrete code-change request`;
        commentClosedPrFollowup(targetNumber, [
          "Handoff stop: this pull request is no longer open.",
          "",
          "Please include a concrete patch/fix request with `/orchestrate` so Sepo can create a fresh implementation issue against the default branch.",
        ].join("\n"));
        return { decision: "stop", reason, nextRound };
      }

      const authStop = delegatedRouteAuthorizationStop("implement", nextRound);
      if (authStop) {
        commentClosedPrFollowup(targetNumber, [
          "Handoff stop: this pull request is no longer open.",
          "",
          `${authStop.reason} No follow-up issue was created.`,
        ].join("\n"));
        return authStop;
      }

      const followupKey = buildClosedPrFollowupKey(targetNumber);
      const nowMs = Date.now();
      const existingFollowups = findClosedPrFollowupMarkers(targetNumber, followupKey);
      const existingFollowupTarget = existingFollowups
        .find((marker) => marker.state !== "failed" && marker.targetNumber);
      if (existingFollowupTarget) {
        return {
          decision: "dispatch",
          nextAction: "implement",
          targetNumber: existingFollowupTarget.targetNumber,
          reason: `manual orchestrate start on ${status.state.toLowerCase()} PR; reusing follow-up issue #${existingFollowupTarget.targetNumber} and dispatching implement`,
          nextRound,
        };
      }
      const activeReservation = existingFollowups.find((marker) => (
        marker.state === "pending" && !isPendingHandoffMarkerStale(marker, nowMs, PENDING_MARKER_TTL_MS)
      ));
      if (activeReservation) {
        return {
          decision: "stop",
          reason: "closed pull request follow-up issue creation is already pending",
          nextRound,
        };
      }

      for (const staleMarker of existingFollowups.filter((marker) =>
        !marker.targetNumber && isPendingHandoffMarkerStale(marker, nowMs, PENDING_MARKER_TTL_MS)
      )) {
        try {
          updateIssueComment(repo, staleMarker.id, formatClosedPrFollowupMarkerComment({
            key: followupKey,
            state: "failed",
            prNumber: targetNumber,
            error: "Pending follow-up reservation expired before issue creation completed; retrying.",
          }));
        } catch (err: unknown) {
          console.warn(`Failed to expire stale closed-PR follow-up marker ${staleMarker.id}: ${errorText(err)}`);
        }
      }

      const reservationId = createIssueComment(repo, parsePositiveTargetNumber(targetNumber), formatClosedPrFollowupMarkerComment({
        key: followupKey,
        state: "pending",
        prNumber: targetNumber,
        createdAtMs: nowMs,
      }));

      let followup: { number: string; url: string } | null = null;
      try {
        followup = createFollowupIssueForClosedPr(targetNumber);
      } catch (err: unknown) {
        updateIssueComment(repo, reservationId, formatClosedPrFollowupMarkerComment({
          key: followupKey,
          state: "failed",
          prNumber: targetNumber,
          error: errorText(err).slice(0, 1000),
        }));
        throw err;
      }
      if (!followup) {
        updateIssueComment(repo, reservationId, formatClosedPrFollowupMarkerComment({
          key: followupKey,
          state: "failed",
          prNumber: targetNumber,
          error: "Could not parse created follow-up issue number.",
        }));
        return { decision: "stop", reason: "could not create follow-up issue for closed pull request", nextRound };
      }
      persistClosedPrFollowupTarget({
        reservationId,
        followupKey,
        prNumber: targetNumber,
        followup,
        createdAtMs: nowMs,
      });
      deferred.closedPrComment = {
        prNumber: targetNumber,
        body: [
          `Created follow-up issue ${followup.url} for this post-merge request and dispatched implementation against the default branch.`,
          "",
          "The original PR is no longer open, so Sepo will continue the patch as fresh issue-backed work.",
        ].join("\n"),
      };
      return {
        decision: "dispatch",
        nextAction: "implement",
        targetNumber: followup.number,
        reason: `manual orchestrate start on ${status.state.toLowerCase()} PR; created follow-up issue #${followup.number} and dispatching implement`,
        nextRound,
      };
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

  return delegatedRouteAuthorizationStop(decision.nextAction, decision.nextRound) || decision;
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
  if (deferred.closedPrComment) {
    commentClosedPrFollowup(deferred.closedPrComment.prNumber, deferred.closedPrComment.body);
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
  if (deferred.closedPrComment) {
    commentClosedPrFollowup(deferred.closedPrComment.prNumber, [
      "Created a follow-up issue for this post-merge request, but dispatching implementation failed.",
      "",
      `Error: ${message}`,
    ].join("\n"));
  }
  throw err;
}

try {
  updateIssueComment(repo, markerCommentId, formatHandoffMarkerComment({
    key: dedupeKey,
    state: "dispatched",
    sourceAction,
    nextAction: decision.nextAction,
    nextRound: decision.nextRound,
    maxRounds,
    reason: decision.reason,
  }));
} catch (err: unknown) {
  console.warn(`Handoff dispatched but marker ${markerCommentId} remained pending: ${errorText(err)}`);
}

console.log(`Handoff dispatched ${decision.nextAction} for #${decision.targetNumber}: ${decision.reason}`);
