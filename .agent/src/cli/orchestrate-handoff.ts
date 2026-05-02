// CLI: post-action handoff orchestrator.
// Env: AUTOMATION_MODE, SOURCE_ACTION, SOURCE_CONCLUSION, TARGET_NUMBER,
//      NEXT_TARGET_NUMBER, AUTOMATION_CURRENT_ROUND, AUTOMATION_MAX_ROUNDS,
//      GITHUB_REPOSITORY, DEFAULT_BRANCH, REQUESTED_BY, REQUEST_TEXT,
//      SESSION_BUNDLE_MODE, SOURCE_RUN_ID, PLANNER_RESPONSE_FILE, TARGET_KIND,
//      BASE_BRANCH, BASE_PR, AGENT_COLLAPSE_OLD_REVIEWS

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { initialOrchestrateCapabilityStopReason } from "../orchestrator-capabilities.js";
import { collapsePreviousHandoffComments } from "../review-summary-minimize.js";
import {
  extractClosingIssueNumber,
  formatSubOrchestrationIssueBody,
  formatSubOrchestratorChildLinkMarker,
  normalizeSubOrchestratorStage,
  parseSubOrchestratorChildLinkMarker,
  parseSubOrchestratorMarker,
  resultStateFromTerminal,
  updateSubOrchestratorMarkerParentRound,
  updateSubOrchestratorMarkerState,
  type SubOrchestratorState,
} from "../sub-orchestration.js";

interface CommentRecord {
  id?: string | number;
  body?: string;
  authorLogin?: string;
}

interface HandoffMarkerRecord extends HandoffMarkerInfo {
  id: string;
}

interface IssueRecord {
  number: number;
  title: string;
  body: string;
  authorLogin?: string;
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

function parseOptionalChildIssueNumber(value: string | undefined): number {
  const text = String(value || "").trim();
  if (!text) return 0;
  if (!/^\d+$/.test(text)) {
    throw new Error(`child_issue_number must be a positive issue number: ${text}`);
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`child_issue_number must be a positive issue number: ${text}`);
  }
  return parsed;
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

function extractLogin(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" ? login.trim() : "";
}

function authorLoginFromRecord(record: Record<string, unknown>): string {
  return extractLogin(record.author) || extractLogin(record.user);
}

function normalizeActorLogin(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/\[bot\]$/i, "");
}

let authenticatedActorLogin: string | null = null;

function fetchAuthenticatedActorLogin(): string {
  if (authenticatedActorLogin !== null) return authenticatedActorLogin;
  const raw = gh([
    "api",
    "graphql",
    "-f",
    "query=query ViewerLogin { viewer { login } }",
  ]).trim();
  const parsed = JSON.parse(raw || "{}") as {
    data?: { viewer?: { login?: unknown } | null } | null;
    viewer?: { login?: unknown } | null;
  };
  const login = String(parsed.data?.viewer?.login || parsed.viewer?.login || "").trim();
  if (!login) throw new Error("Could not resolve authenticated GitHub actor login");
  authenticatedActorLogin = login;
  return authenticatedActorLogin;
}

function isTrustedActorLogin(authorLogin: string): boolean {
  const normalizedAuthor = normalizeActorLogin(authorLogin);
  if (!normalizedAuthor) return false;
  return normalizedAuthor === normalizeActorLogin(fetchAuthenticatedActorLogin());
}

function isTrustedIssueRecord(issue: IssueRecord): boolean {
  return isTrustedActorLogin(issue.authorLogin || "");
}

function normalizeCommentRecord(value: unknown): CommentRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    id: record.id as string | number | undefined,
    body: String(record.body || ""),
    authorLogin: authorLoginFromRecord(record),
  };
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

function fetchIssue(repoSlug: string, issueNumber: number): IssueRecord | null {
  try {
    return fetchIssueStrict(repoSlug, issueNumber);
  } catch {
    return null;
  }
}

function fetchIssueStrict(repoSlug: string, issueNumber: number): IssueRecord {
  const raw = gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repoSlug,
    "--json",
    "number,title,body,author",
  ]).trim();
  if (!raw) throw new Error(`empty issue response for #${issueNumber}`);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    number: Number(parsed.number || issueNumber),
    title: String(parsed.title || ""),
    body: String(parsed.body || ""),
    authorLogin: authorLoginFromRecord(parsed),
  };
}

function withTempBodyFile<T>(body: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sepo-sub-orchestrator-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, body, "utf8");
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function updateIssueBody(repoSlug: string, issueNumber: number, body: string): void {
  withTempBodyFile(body, (bodyFile) => {
    gh(["issue", "edit", String(issueNumber), "--repo", repoSlug, "--body-file", bodyFile]);
  });
}

function createIssueFromBody(repoSlug: string, title: string, body: string): string {
  return withTempBodyFile(body, (bodyFile) => gh([
    "issue",
    "create",
    "--repo",
    repoSlug,
    "--title",
    title,
    "--body-file",
    bodyFile,
  ]).trim());
}

function parseIssueNumberFromUrl(url: string): string {
  const match = String(url || "").trim().match(/\/issues\/(\d+)(?:\D*)?$/);
  return match ? match[1] : "";
}

function findExistingSubOrchestrationIssue(repoSlug: string, parentIssue: number, stage: string): IssueRecord | null {
  const expectedStage = normalizeSubOrchestratorStage(stage);
  const raw = gh([
    "issue",
    "list",
    "--repo",
    repoSlug,
    "--state",
    "open",
    "--search",
    "sepo-sub-orchestrator",
    "--json",
    "number,title,body,author",
    "--limit",
    "100",
  ]).trim();
  const parsed = JSON.parse(raw || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("could not parse existing sub-orchestrator issue search results");
  }
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = parsePositiveTargetNumber(String(record.number || ""));
    const body = String(record.body || "");
    const marker = parseSubOrchestratorMarker(body);
    if (number && marker?.parent === parentIssue && marker.stage === expectedStage && marker.state === "running") {
      const issue: IssueRecord = {
        number,
        title: String(record.title || ""),
        body,
        authorLogin: authorLoginFromRecord(record),
      };
      if (isTrustedIssueRecord(issue)) return issue;
    }
  }
  return null;
}

function findRecordedSubOrchestrationIssue(repoSlug: string, parentIssue: number, stage: string): IssueRecord | null {
  const expectedStage = normalizeSubOrchestratorStage(stage);
  const comments = fetchIssueComments(repoSlug, parentIssue);
  for (const comment of [...comments].reverse()) {
    const link = parseSubOrchestratorChildLinkMarker(comment.body || "");
    if (!link || link.parent !== parentIssue || link.stage !== expectedStage) continue;
    if (!isTrustedActorLogin(comment.authorLogin || "")) continue;

    const existing = fetchIssue(repoSlug, link.child);
    if (!existing) throw new Error(`Could not read recorded child issue #${link.child}`);
    validateReusableChildIssue(existing, parentIssue, stage);
    return existing;
  }
  return null;
}

function recordSubOrchestrationIssue(repoSlug: string, parentIssue: number, stage: string, childIssue: number): void {
  createIssueComment(
    repoSlug,
    parentIssue,
    [
      `Sub-orchestrator child selected for ${normalizeSubOrchestratorStage(stage)}: #${childIssue}`,
      "",
      formatSubOrchestratorChildLinkMarker({ parent: parentIssue, stage, child: childIssue }),
    ].join("\n"),
  );
}

function validateReusableChildIssue(existing: IssueRecord, parentIssue: number, stage: string): void {
  const marker = parseSubOrchestratorMarker(existing.body);
  const expectedStage = normalizeSubOrchestratorStage(stage);
  if (!isTrustedIssueRecord(existing)) {
    throw new Error(`child issue #${existing.number} was not created by the authenticated agent`);
  }
  if (!marker) {
    throw new Error(`child issue #${existing.number} is missing a sepo-sub-orchestrator marker`);
  }
  if (marker.parent !== parentIssue) {
    throw new Error(`child issue #${existing.number} belongs to parent #${marker.parent}, not #${parentIssue}`);
  }
  if (marker.stage !== expectedStage) {
    throw new Error(`child issue #${existing.number} is stage ${marker.stage}, not ${expectedStage}`);
  }
  if (marker.state !== "running") {
    throw new Error(`child issue #${existing.number} is ${marker.state}, not reusable`);
  }
}

function ensureSubOrchestrationIssue(decision: HandoffDecision): string {
  const parentIssue = parsePositiveTargetNumber(targetNumber);
  if (!parentIssue) throw new Error(`Invalid parent issue number: ${targetNumber}`);
  const effectiveBaseBranch = decision.baseBranch || baseBranch;
  const effectiveBasePr = decision.basePr || basePr;
  if (effectiveBaseBranch && effectiveBasePr) {
    throw new Error("set only one of base_branch or base_pr for child orchestration");
  }

  const stage = decision.childStage || `stage-${decision.nextRound - 1}`;
  const instructions = decision.childInstructions || decision.handoffContext || requestText;
  const existingIssueNumber = parseOptionalChildIssueNumber(decision.childIssueNumber);
  const parentRound = decision.nextRound;

  if (existingIssueNumber) {
    const existing = fetchIssue(repo, existingIssueNumber);
    if (!existing) throw new Error(`Could not read child issue #${existingIssueNumber}`);
    validateReusableChildIssue(existing, parentIssue, stage);
    const updatedBody = updateSubOrchestratorMarkerParentRound(existing.body, parentRound);
    if (updatedBody !== existing.body) updateIssueBody(repo, existing.number, updatedBody);
    recordSubOrchestrationIssue(repo, parentIssue, stage, existing.number);
    return String(existingIssueNumber);
  }

  const recordedIssue = findRecordedSubOrchestrationIssue(repo, parentIssue, stage);
  if (recordedIssue) {
    const updatedBody = updateSubOrchestratorMarkerParentRound(recordedIssue.body, parentRound);
    if (updatedBody !== recordedIssue.body) updateIssueBody(repo, recordedIssue.number, updatedBody);
    return String(recordedIssue.number);
  }

  const reusableIssue = findExistingSubOrchestrationIssue(repo, parentIssue, stage);
  if (reusableIssue) {
    const updatedBody = updateSubOrchestratorMarkerParentRound(reusableIssue.body, parentRound);
    if (updatedBody !== reusableIssue.body) updateIssueBody(repo, reusableIssue.number, updatedBody);
    recordSubOrchestrationIssue(repo, parentIssue, stage, reusableIssue.number);
    return String(reusableIssue.number);
  }

  const title = `Sub-orchestrator: ${stage}`;
  const body = formatSubOrchestrationIssueBody({
    parentIssue,
    stage,
    taskInstructions: instructions,
    baseBranch: effectiveBaseBranch,
    basePr: effectiveBasePr,
    parentRound,
  });
  const createdUrl = createIssueFromBody(repo, title, body);
  const createdNumber = parseIssueNumberFromUrl(createdUrl);
  if (!createdNumber) throw new Error(`Could not parse created child issue URL: ${createdUrl}`);
  recordSubOrchestrationIssue(repo, parentIssue, stage, parsePositiveTargetNumber(createdNumber));
  return createdNumber;
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

function readPrBodyStrict(repoSlug: string, prNumber: string): string {
  const raw = gh(["pr", "view", prNumber, "--repo", repoSlug, "--json", "body"]).trim();
  if (!raw) throw new Error(`empty pull request response for #${prNumber}`);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return String(parsed.body || "");
}

function resolveChildIssueForTerminal(): IssueRecord | null {
  const normalizedKind = normalizeToken(sourceTargetKind);
  const currentNumber = parsePositiveTargetNumber(targetNumber);
  if (!repo || !currentNumber) return null;
  if (normalizedKind === "issue") {
    const issue = fetchIssueStrict(repo, currentNumber);
    return issue && isTrustedIssueRecord(issue) && parseSubOrchestratorMarker(issue.body) ? issue : null;
  }
  if (normalizedKind === "pull_request") {
    const linkedIssueNumber = extractClosingIssueNumber(readPrBodyStrict(repo, targetNumber), repo);
    if (!linkedIssueNumber) return null;
    const issue = fetchIssueStrict(repo, linkedIssueNumber);
    return issue && isTrustedIssueRecord(issue) && parseSubOrchestratorMarker(issue.body) ? issue : null;
  }
  return null;
}

function reportTerminalToParent(decision: HandoffDecision): void {
  const childIssue = resolveChildIssueForTerminal();
  if (!childIssue) return;
  const marker = parseSubOrchestratorMarker(childIssue.body);
  if (!marker || !["running", "done", "blocked", "failed"].includes(marker.state)) return;

  const resultState = marker.state === "running" ? resultStateFromTerminal({
    sourceAction,
    sourceConclusion,
    reason: decision.reason,
  }) : marker.state;
  const parentRound = marker.parentRound || 1;
  const result = resultState === "done" ? "SHIP" : resultState.toUpperCase();
  const prLine = normalizeToken(sourceTargetKind) === "pull_request" ? `PR: #${targetNumber}\n` : "";
  const progressMarkerPrefix = `sepo-sub-orchestrator-report child:${childIssue.number}`;
  const pendingProgressMarker = `<!-- ${progressMarkerPrefix} resume:pending -->`;
  const dispatchedProgressMarker = `<!-- ${progressMarkerPrefix} resume:dispatched -->`;
  const progressLines = [
    `Sub-orchestrator ${marker.stage} finished`,
    "",
    `Child issue: #${childIssue.number}`,
    prLine.trim(),
    `Result: ${result}`,
    `Parent round: ${parentRound}/${maxRounds}`,
    `Summary: ${decision.reason}`,
    "Next: waiting for meta orchestrator",
    "",
  ].filter(Boolean);

  const existingProgress = fetchIssueComments(repo, marker.parent).find((comment) =>
    String(comment.body || "").includes(progressMarkerPrefix) && isTrustedActorLogin(comment.authorLogin || "")
  );
  const progressWasDispatched = String(existingProgress?.body || "").includes(dispatchedProgressMarker);
  if (marker.state !== "running" && progressWasDispatched) {
    return;
  }
  let progressCommentId = existingProgress?.id ? String(existingProgress.id) : "";
  const writeProgress = (progressMarker: string): void => {
    const progressBody = [...progressLines, progressMarker].join("\n");
    if (progressCommentId) {
      updateIssueComment(repo, progressCommentId, progressBody);
    } else {
      progressCommentId = createIssueComment(repo, marker.parent, progressBody);
    }
  };

  if (!progressWasDispatched) {
    writeProgress(pendingProgressMarker);

    dispatchWorkflow(repo, "agent-orchestrator.yml", ref, {
      source_action: "orchestrate",
      source_conclusion: resultState,
      source_run_id: sourceRunId,
      target_kind: "issue",
      target_number: String(marker.parent),
      requested_by: requestedBy,
      request_text: `Child issue #${childIssue.number} finished with ${result}: ${decision.reason}`,
      automation_mode: "agent",
      automation_current_round: String(parentRound),
      automation_max_rounds: String(maxRounds),
      session_bundle_mode: sessionBundleMode,
      base_branch: baseBranch,
      base_pr: basePr,
    });

    writeProgress(dispatchedProgressMarker);
  }

  const updatedChildBody = marker.state === "running"
    ? updateSubOrchestratorMarkerState(childIssue.body, resultState as SubOrchestratorState)
    : childIssue.body;
  if (updatedChildBody !== childIssue.body) {
    updateIssueBody(repo, childIssue.number, updatedChildBody);
  }
}

function createOrchestrateStopComment(decision: HandoffDecision): void {
  const target = parsePositiveTargetNumber(targetNumber);
  if (!repo || !target || !["issue", "pull_request"].includes(normalizeToken(sourceTargetKind))) {
    return;
  }
  createIssueComment(
    repo,
    target,
    [
      `Sepo orchestration stopped: ${decision.reason}`,
      "",
      "<!-- sepo-agent-orchestrate-stop -->",
    ].join("\n"),
  );
}

function commentOnInitialOrchestrateStop(decision: HandoffDecision): void {
  if (
    normalizeToken(sourceAction) !== "orchestrate" ||
    normalizeToken(sourceConclusion) !== "requested" ||
    currentRound !== 1
  ) {
    return;
  }
  createOrchestrateStopComment(decision);
}

function commentOnDelegationFailure(decision: HandoffDecision): void {
  if (normalizeToken(sourceAction) !== "orchestrate") {
    return;
  }
  createOrchestrateStopComment(decision);
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

function validateInitialOrchestrateCapabilities(): HandoffDecision | null {
  const reason = initialOrchestrateCapabilityStopReason({
    sourceAction,
    sourceConclusion,
    currentRound,
    authorAssociation: sourceAssociationRaw,
    accessPolicy: accessPolicyRaw,
    isPublicRepo,
  });
  return reason ? { decision: "stop", reason, nextRound: currentRound + 1 } : null;
}

const authorizationStop = validateInitialOrchestrateCapabilities();
const routeDecision = authorizationStop || (normalizeToken(sourceAction) === "orchestrate"
  ? automationMode === "agent" && normalizeToken(sourceTargetKind) === "issue"
    ? decideHandoff({
      automationMode,
      sourceAction,
      sourceConclusion,
      targetKind: sourceTargetKind,
      targetNumber,
      nextTargetNumber: process.env.NEXT_TARGET_NUMBER || "",
      currentRound,
      maxRounds,
      plannerDecision: readPlannerDecision(),
    })
    : decideManualOrchestration()
  : decideHandoff({
    automationMode,
    sourceAction,
    sourceConclusion,
    targetKind: sourceTargetKind,
    targetNumber,
    nextTargetNumber: process.env.NEXT_TARGET_NUMBER || "",
    currentRound,
    maxRounds,
    plannerDecision: automationMode === "agent" ? readPlannerDecision() : null,
  }));
const decision = routeDecision;

setOutput("decision", decision.decision);
setOutput("next_action", decision.decision === "delegate_issue" ? "delegate_issue" : decision.nextAction || "");
setOutput("target_number", decision.targetNumber || "");
setOutput("reason", decision.reason);
setOutput("next_round", String(decision.nextRound));
setOutput("handoff_context", decision.handoffContext || "");
setOutput("deduped", "false");
setOutput("dedupe_key", "");
setOutput("marker_comment_id", "");

if (decision.decision !== "dispatch" && decision.decision !== "delegate_issue") {
  console.log(`Handoff ${decision.decision}: ${decision.reason}`);
  try {
    commentOnInitialOrchestrateStop(decision);
    reportTerminalToParent(decision);
  } catch (err: unknown) {
    console.warn(`Failed to report terminal sub-orchestration state: ${errorText(err)}`);
  }
  process.exit(0);
}

if (!repo || !ref || (!decision.nextAction && decision.decision !== "delegate_issue") || !decision.targetNumber) {
  console.error("Missing required dispatch context for handoff");
  process.exit(2);
}

let dispatchTargetNumber = decision.targetNumber;
const dispatchName = decision.decision === "delegate_issue" ? "delegate_issue" : decision.nextAction || "";
if (decision.decision === "delegate_issue") {
  try {
    dispatchTargetNumber = ensureSubOrchestrationIssue(decision);
    decision.targetNumber = dispatchTargetNumber;
    setOutput("target_number", dispatchTargetNumber);
  } catch (err: unknown) {
    const message = `child issue delegation failed: ${errorText(err).slice(0, 1000)}`;
    const stopDecision: HandoffDecision = {
      decision: "stop",
      reason: message,
      nextRound: decision.nextRound,
      targetNumber,
    };
    setOutput("decision", "stop");
    setOutput("next_action", "");
    setOutput("target_number", targetNumber);
    setOutput("reason", message);
    console.error(message);
    try {
      commentOnDelegationFailure(stopDecision);
    } catch (commentErr: unknown) {
      console.warn(`Failed to report child issue delegation failure: ${errorText(commentErr)}`);
    }
    process.exit(0);
  }
}

const dedupeKey = buildHandoffDedupeKey({
  repo,
  sourceRunId,
  sourceAction,
  sourceTargetNumber: targetNumber,
  nextAction: dispatchName,
  nextTargetNumber: dispatchTargetNumber,
  nextRound: decision.nextRound,
});
setOutput("dedupe_key", dedupeKey);

const markerTargetNumber = parsePositiveTargetNumber(dispatchTargetNumber);
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
      nextAction: dispatchName,
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
  nextAction: dispatchName,
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
  } else if (decision.decision === "delegate_issue") {
    dispatchWorkflow(repo, "agent-orchestrator.yml", ref, {
      requested_by: requestedBy,
      request_text: requestText,
      automation_max_rounds: String(maxRounds),
      session_bundle_mode: sessionBundleMode,
      source_action: "orchestrate",
      source_conclusion: "delegated",
      source_run_id: sourceRunId,
      target_kind: "issue",
      target_number: dispatchTargetNumber,
      automation_mode: "heuristics",
      automation_current_round: "1",
      base_branch: decision.baseBranch || baseBranch,
      base_pr: decision.basePr || basePr,
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
      nextAction: dispatchName,
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
  nextAction: dispatchName,
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
      targetKind: decision.nextAction === "implement" || decision.decision === "delegate_issue" ? "issue" : "pull_request",
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

console.log(`Handoff dispatched ${dispatchName} for #${decision.targetNumber}: ${decision.reason}`);
