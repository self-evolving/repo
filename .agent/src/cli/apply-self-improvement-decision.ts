#!/usr/bin/env node
// CLI: apply a self-improvement planner decision.
//
// Env:
//   RESPONSE_FILE                  planner response markdown/json file
//   GITHUB_REPOSITORY              owner/repo slug
//   DEFAULT_BRANCH                 workflow dispatch ref
//   GITHUB_RUN_ID                  source run id
//   GITHUB_SERVER_URL              GitHub base URL
//   GITHUB_EVENT_NAME              schedule or workflow_dispatch
//   REQUESTED_BY                   audit requester
//   AUTHOR_ASSOCIATION             authorization context for initial orchestrate
//   ACCESS_POLICY                  AGENT_ACCESS_POLICY JSON
//   REPOSITORY_PRIVATE             true/false
//   AGENT_ALLOW_SELF_APPROVE       true/false
//   AGENT_ALLOW_SELF_MERGE         true/false
//   AUTOMATION_MODE                agent/heuristics/disabled
//   AUTOMATION_MAX_ROUNDS          max orchestrator rounds
//   SESSION_BUNDLE_MODE            session bundle mode
//   REQUEST_TEXT                   forwarded request text
//
// Outputs:
//   decision, target_kind, target_number, issue_url, comment_posted

import { readFileSync } from "node:fs";
import { resolveGithubActorAssociation } from "../actor-association.js";
import {
  createIssue,
  dispatchWorkflow,
  fetchAuthenticatedActorLogin,
  fetchIssueCommentRecords,
  gh,
  normalizeActorLogin,
  postIssueComment,
  postPrComment,
} from "../github.js";
import { initialOrchestrateCapabilityStopReason } from "../orchestrator-capabilities.js";
import { setOutput } from "../output.js";
import {
  SELF_IMPROVEMENT_DECISION_MARKER,
  SELF_IMPROVEMENT_PROPOSAL_MARKER,
  buildSelfImprovementContinuationComment,
  buildSelfImprovementIssueBody,
  normalizeIssueTitle,
  parseSelfImprovementDecision,
  selfImprovementRunMarker,
  writeTempMarkdownFile,
  type SelfImprovementDecision,
  type SelfImprovementRunContext,
} from "../self-improvement.js";

function requiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name: string, fallback = ""): string {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

function envFlagEnabled(name: string): boolean {
  return ["true", "1", "yes", "on"].includes(optionalEnv(name).toLowerCase());
}

function validateInitialOrchestrateCapability(): void {
  const reason = initialOrchestrateCapabilityStopReason({
    sourceAction: "orchestrate",
    sourceConclusion: "requested",
    currentRound: 1,
    allowSelfApprove: envFlagEnabled("AGENT_ALLOW_SELF_APPROVE"),
    allowSelfMerge: envFlagEnabled("AGENT_ALLOW_SELF_MERGE"),
    authorAssociation: requiredEnv("AUTHOR_ASSOCIATION"),
    accessPolicy: optionalEnv("ACCESS_POLICY"),
    isPublicRepo: optionalEnv("REPOSITORY_PRIVATE").toLowerCase() === "false",
  });
  if (reason) throw new Error(reason);
}

function sourceRunUrl(repo: string, runId: string): string {
  if (!repo || !runId) return "";
  const server = optionalEnv("GITHUB_SERVER_URL", "https://github.com").replace(/\/+$/, "");
  return `${server}/${repo}/actions/runs/${runId}`;
}

function parseCreatedIssueNumber(issueUrl: string): number {
  const match = String(issueUrl || "").match(/\/(?:issues|pull)\/(\d+)(?:\b|$)|\/(\d+)$/);
  const parsed = Number(match?.[1] || match?.[2] || "");
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Could not parse created issue number from URL: ${issueUrl}`);
  }
  return parsed;
}

function asRecordArray(raw: string): Record<string, unknown>[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function fallbackIssueUrl(repo: string, issueNumber: number): string {
  const server = optionalEnv("GITHUB_SERVER_URL", "https://github.com").replace(/\/+$/, "");
  return `${server}/${repo}/issues/${issueNumber}`;
}

function loginFromRecord(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" ? login.trim() : "";
}

function issueAuthorLogin(issue: Record<string, unknown>): string {
  return loginFromRecord(issue.user) || loginFromRecord(issue.author);
}

function isTrustedAssociation(association: string): boolean {
  const normalized = String(association || "").trim().toUpperCase();
  return normalized === "OWNER" || normalized === "MEMBER" || normalized === "COLLABORATOR";
}

function isTrustedAuthorLogin(authorLogin: string, authenticatedLogin: string): boolean {
  const normalizedAuthor = normalizeActorLogin(authorLogin);
  return Boolean(normalizedAuthor) && normalizedAuthor === normalizeActorLogin(authenticatedLogin);
}

function isTrustedContinuationTargetAuthor(authorLogin: string, repo: string): boolean {
  if (!authorLogin) return false;
  const association = resolveGithubActorAssociation({
    repo,
    actorLogin: authorLogin,
    lookupOrder: "repository-first",
  });
  if (isTrustedAssociation(association)) return true;
  return isTrustedAuthorLogin(authorLogin, fetchAuthenticatedActorLogin());
}

function findExistingRunProposalIssue(context: SelfImprovementRunContext): { issueUrl: string; targetNumber: number } | null {
  const marker = selfImprovementRunMarker(context.runId);
  if (!marker) return null;
  let authenticatedLogin = "";

  const issues = asRecordArray(gh([
    "api",
    "--method",
    "GET",
    `repos/${context.repo}/issues`,
    "-f",
    "state=all",
    "-f",
    "per_page=100",
  ]));
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const state = String(issue.state || "").trim().toLowerCase();
    if (state && state !== "open") continue;
    const body = String(issue.body || "");
    if (
      !body.includes(marker) ||
      !body.includes(SELF_IMPROVEMENT_PROPOSAL_MARKER) ||
      !body.includes(SELF_IMPROVEMENT_DECISION_MARKER)
    ) {
      continue;
    }
    const authorLogin = issueAuthorLogin(issue);
    if (!authorLogin) continue;
    authenticatedLogin ||= fetchAuthenticatedActorLogin();
    if (!isTrustedAuthorLogin(authorLogin, authenticatedLogin)) continue;

    const number = Number(issue.number || "");
    if (!Number.isInteger(number) || number <= 0) continue;
    return {
      issueUrl: String(issue.html_url || "") || fallbackIssueUrl(context.repo, number),
      targetNumber: number,
    };
  }
  return null;
}

function createNewProposalIssue(
  decision: SelfImprovementDecision,
  context: SelfImprovementRunContext,
): { issueUrl: string; targetNumber: number } {
  const existing = findExistingRunProposalIssue(context);
  if (existing) return existing;

  const body = buildSelfImprovementIssueBody(decision, context);
  const bodyFile = writeTempMarkdownFile("agent-self-improvement-issue", body);
  const issueUrl = createIssue({
    title: normalizeIssueTitle(decision.issueTitle),
    bodyFile,
    repo: context.repo,
  });
  return {
    issueUrl,
    targetNumber: parseCreatedIssueNumber(issueUrl),
  };
}

function validateContinuationTarget(
  decision: SelfImprovementDecision,
  repo: string,
): void {
  const targetNumber = decision.targetNumber || 0;
  if (!targetNumber) throw new Error(`${decision.decision} is missing target number`);
  let target: Record<string, unknown> | null = null;

  if (decision.decision === "continue_pr") {
    try {
      target = JSON.parse(gh([
        "api",
        `repos/${repo}/pulls/${targetNumber}`,
      ])) as Record<string, unknown>;
    } catch {
      target = null;
    }
    const state = String(target?.state || "").trim().toLowerCase();
    if (state !== "open") {
      throw new Error(`continue_pr target #${targetNumber} must be an open pull request; got ${state || "missing"}`);
    }
  } else {
    try {
      target = JSON.parse(gh([
        "api",
        `repos/${repo}/issues/${targetNumber}`,
      ])) as Record<string, unknown>;
    } catch {
      target = null;
    }
    const state = String(target?.state || "").trim().toLowerCase();
    if (target?.pull_request) {
      throw new Error(`continue_issue target #${targetNumber} is a pull request, not an issue`);
    }
    if (state !== "open") {
      throw new Error(`continue_issue target #${targetNumber} must be an open issue; got ${state || "missing"}`);
    }
  }

  if (!isTrustedContinuationTargetAuthor(issueAuthorLogin(target || {}), repo)) {
    throw new Error(
      `${decision.decision} target #${targetNumber} must be authored by Sepo or a trusted repository actor`,
    );
  }
}

function hasExistingRunContinuationComment(
  decision: SelfImprovementDecision,
  context: SelfImprovementRunContext,
): boolean {
  const marker = selfImprovementRunMarker(context.runId);
  const targetNumber = decision.targetNumber || 0;
  if (!marker || !targetNumber) return false;

  const comments = fetchIssueCommentRecords(targetNumber, context.repo);
  let authenticatedLogin = "";
  return comments.some((comment) => {
    const body = String(comment.body || "");
    if (!body.includes(marker) || !body.includes(SELF_IMPROVEMENT_DECISION_MARKER)) return false;
    if (!comment.authorLogin) return false;
    authenticatedLogin ||= fetchAuthenticatedActorLogin();
    return isTrustedAuthorLogin(comment.authorLogin, authenticatedLogin);
  });
}

function postContinuationComment(
  decision: SelfImprovementDecision,
  context: SelfImprovementRunContext,
): boolean {
  const targetNumber = decision.targetNumber || 0;
  if (!targetNumber) throw new Error(`${decision.decision} is missing target number`);
  validateContinuationTarget(decision, context.repo);
  if (hasExistingRunContinuationComment(decision, context)) {
    return false;
  }

  const body = buildSelfImprovementContinuationComment(decision, context);
  if (decision.decision === "continue_pr") {
    postPrComment(targetNumber, body, context.repo);
  } else {
    postIssueComment(targetNumber, body, context.repo);
  }
  return true;
}

function dispatchOrchestrator(input: {
  repo: string;
  ref: string;
  decision: SelfImprovementDecision;
  targetKind: string;
  targetNumber: number;
  issueUrl?: string;
}): void {
  const requestText = optionalEnv("REQUEST_TEXT") || [
    "Scheduled self-improvement selected a target and is dispatching agent-orchestrator.yml.",
    `Decision: ${input.decision.decision}.`,
    `Reason: ${input.decision.reason}`,
    input.issueUrl ? `Created proposal issue: ${input.issueUrl}` : "",
  ].filter(Boolean).join("\n");

  dispatchWorkflow(input.repo, "agent-orchestrator.yml", input.ref, {
    automation_mode: optionalEnv("AUTOMATION_MODE", "agent"),
    automation_current_round: "1",
    automation_max_rounds: optionalEnv("AUTOMATION_MAX_ROUNDS", "12"),
    source_action: "orchestrate",
    source_conclusion: "requested",
    source_recommended_next_step: "",
    source_run_id: optionalEnv("GITHUB_RUN_ID"),
    target_kind: input.targetKind,
    target_number: String(input.targetNumber),
    author_association: requiredEnv("AUTHOR_ASSOCIATION"),
    access_policy: optionalEnv("ACCESS_POLICY"),
    repository_private: optionalEnv("REPOSITORY_PRIVATE"),
    next_target_number: "",
    source_handoff_context: "",
    requested_by: optionalEnv("REQUESTED_BY", optionalEnv("GITHUB_ACTOR", "github-actions[bot]")),
    request_text: requestText,
    session_bundle_mode: optionalEnv("SESSION_BUNDLE_MODE"),
    base_branch: "",
    base_pr: "",
  });
}

export function runApplySelfImprovementDecision(): number {
  try {
    const responseFile = requiredEnv("RESPONSE_FILE");
    const repo = requiredEnv("GITHUB_REPOSITORY");
    const ref = requiredEnv("DEFAULT_BRANCH");
    const runId = optionalEnv("GITHUB_RUN_ID");
    const decision = parseSelfImprovementDecision(readFileSync(responseFile, "utf8"));
    validateInitialOrchestrateCapability();
    const context: SelfImprovementRunContext = {
      repo,
      runId,
      runUrl: sourceRunUrl(repo, runId),
      eventName: optionalEnv("GITHUB_EVENT_NAME"),
    };

    let targetKind = decision.decision === "continue_pr" ? "pull_request" : "issue";
    let targetNumber = decision.targetNumber || 0;
    let issueUrl = "";
    let commentPosted = "false";

    if (decision.decision === "new_issue") {
      const created = createNewProposalIssue(decision, context);
      issueUrl = created.issueUrl;
      targetNumber = created.targetNumber;
      targetKind = "issue";
    } else {
      commentPosted = postContinuationComment(decision, context) ? "true" : "false";
    }

    if (!targetNumber) {
      throw new Error(`Could not resolve target number for ${decision.decision}`);
    }

    dispatchOrchestrator({
      repo,
      ref,
      decision,
      targetKind,
      targetNumber,
      issueUrl,
    });

    setOutput("decision", decision.decision);
    setOutput("target_kind", targetKind);
    setOutput("target_number", String(targetNumber));
    setOutput("issue_url", issueUrl);
    setOutput("comment_posted", commentPosted);
    console.log(`Applied self-improvement decision ${decision.decision} on ${targetKind} #${targetNumber}`);
    return 0;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runApplySelfImprovementDecision();
}
