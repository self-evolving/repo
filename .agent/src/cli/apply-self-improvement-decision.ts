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
//   AUTOMATION_MODE                agent/heuristics/disabled
//   AUTOMATION_MAX_ROUNDS          max orchestrator rounds
//   SESSION_BUNDLE_MODE            session bundle mode
//   REQUEST_TEXT                   forwarded request text
//
// Outputs:
//   decision, target_kind, target_number, issue_url, comment_posted

import { readFileSync } from "node:fs";
import { createIssue, dispatchWorkflow, postIssueComment, postPrComment } from "../github.js";
import { setOutput } from "../output.js";
import {
  buildSelfImprovementContinuationComment,
  buildSelfImprovementIssueBody,
  normalizeIssueTitle,
  parseSelfImprovementDecision,
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

function createNewProposalIssue(
  decision: SelfImprovementDecision,
  context: SelfImprovementRunContext,
): { issueUrl: string; targetNumber: number } {
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

function postContinuationComment(
  decision: SelfImprovementDecision,
  context: SelfImprovementRunContext,
): void {
  const targetNumber = decision.targetNumber || 0;
  if (!targetNumber) throw new Error(`${decision.decision} is missing target number`);
  const body = buildSelfImprovementContinuationComment(decision, context);
  if (decision.decision === "continue_pr") {
    postPrComment(targetNumber, body, context.repo);
  } else {
    postIssueComment(targetNumber, body, context.repo);
  }
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
    author_association: optionalEnv("AUTHOR_ASSOCIATION", "OWNER"),
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
      postContinuationComment(decision, context);
      commentPosted = "true";
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
