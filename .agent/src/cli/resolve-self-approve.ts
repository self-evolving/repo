// CLI: resolve a self-approval agent response and optionally approve a PR.
// Env: RESPONSE_FILE, GITHUB_REPOSITORY, TARGET_NUMBER, TARGET_KIND,
//      EXPECTED_HEAD_SHA, AGENT_ALLOW_SELF_APPROVE, AGENT_ALLOW_SELF_MERGE,
//      SOURCE_RECOMMENDED_NEXT_STEP
// Outputs: conclusion, approved, status_post, handoff_context, reason, body_file

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchAuthenticatedActorLogin,
  fetchIssueCommentRecords,
  fetchPrAuthorLogin,
  fetchPrMeta,
  gh,
} from "../github.js";
import { setOutput } from "../output.js";
import {
  envFlagEnabled,
  evaluateSelfApprovalActor,
  evaluateSelfApprovalProvenance,
  formatSelfApprovalBody,
  parseSelfApprovalDecision,
  resolveSelfApproval,
} from "../self-approval.js";

function writeBodyFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sepo-self-approve-"));
  const file = join(dir, "body.md");
  writeFileSync(file, body, "utf8");
  return file;
}

function readResponse(): string {
  const responseFile = process.env.RESPONSE_FILE || "";
  if (!responseFile) return "";
  try {
    return readFileSync(responseFile, "utf8");
  } catch {
    return "";
  }
}

function currentRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL || "";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  return server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : "";
}

function submitApproval(repo: string, prNumber: number, headSha: string, body: string): void {
  gh([
    "api",
    "--method",
    "POST",
    `repos/${repo}/pulls/${prNumber}/reviews`,
    "-f",
    `commit_id=${headSha}`,
    "-f",
    "event=APPROVE",
    "-f",
    `body=${body}`,
  ]);
}

function normalizeToken(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const repo = process.env.GITHUB_REPOSITORY || "";
const prNumber = Number(process.env.TARGET_NUMBER || process.env.PR_NUMBER || "");
const targetKind = process.env.TARGET_KIND || "pull_request";
const expectedHeadSha = process.env.EXPECTED_HEAD_SHA || "";
const allowSelfApprove = envFlagEnabled(process.env.AGENT_ALLOW_SELF_APPROVE);
const allowSelfMerge = envFlagEnabled(process.env.AGENT_ALLOW_SELF_MERGE);
const allowSameActorSelfApprove = allowSelfApprove && allowSelfMerge;
const sourceRecommendedNextStep = normalizeToken(process.env.SOURCE_RECOMMENDED_NEXT_STEP || "");
const isHumanDecisionGate = sourceRecommendedNextStep === "human_decision";
const decision = parseSelfApprovalDecision(readResponse());

let prState = "";
let currentHeadSha = "";
let metadataReadReason = "";
let approvalActorAllowed = false;
let approvalActorReason = "approval actor could not be verified as distinct from pull request author";
let approvalActorSameAsAuthor = false;
let approvalProvenanceTrusted = false;
let approvalProvenanceReason = "missing trusted review synthesis for self-approval";
if (allowSelfApprove && normalizeToken(targetKind) === "pull_request" && repo && prNumber) {
  let authenticatedActorLogin = "";
  try {
    const meta = fetchPrMeta(prNumber, repo);
    prState = meta.state;
    currentHeadSha = meta.headOid;
  } catch {
    metadataReadReason = "could not read pull request metadata during self-approval resolution";
  }

  try {
    authenticatedActorLogin = fetchAuthenticatedActorLogin();
    const approvalActor = evaluateSelfApprovalActor({
      approvalActorLogin: authenticatedActorLogin,
      prAuthorLogin: fetchPrAuthorLogin(prNumber, repo),
      allowSameActor: allowSameActorSelfApprove,
    });
    approvalActorAllowed = approvalActor.allowed;
    approvalActorReason = approvalActor.reason;
    approvalActorSameAsAuthor = approvalActor.sameActor === true;
  } catch {
    approvalActorAllowed = false;
    approvalActorReason = "could not verify approval actor differs from pull request author";
  }

  try {
    const trustedActorLogin = authenticatedActorLogin || fetchAuthenticatedActorLogin();
    const provenance = evaluateSelfApprovalProvenance({
      comments: fetchIssueCommentRecords(prNumber, repo),
      trustedActorLogin,
      expectedHeadSha,
      allowHumanDecisionGate: isHumanDecisionGate,
    });
    approvalProvenanceTrusted = provenance.trusted;
    approvalProvenanceReason = provenance.reason;
  } catch {
    approvalProvenanceTrusted = false;
    approvalProvenanceReason = "could not read trusted review synthesis";
  }
} else if (allowSelfApprove && normalizeToken(targetKind) === "pull_request") {
  metadataReadReason = "missing pull request target";
}

let result = metadataReadReason
  ? {
    conclusion: "failed" as const,
    shouldApprove: false,
    reason: metadataReadReason,
    handoffContext: decision?.handoffContext || "",
  }
  : resolveSelfApproval({
    allowSelfApprove,
    targetKind,
    prState,
    expectedHeadSha,
    currentHeadSha,
    decision,
    approvalActorAllowed,
    approvalActorReason,
    approvalProvenanceTrusted,
    approvalProvenanceReason,
  });

let approved = false;
let statusPost = true;
if (result.shouldApprove) {
  if (approvalActorSameAsAuthor) {
    approved = true;
  } else {
    try {
      submitApproval(repo, prNumber, expectedHeadSha, formatSelfApprovalBody({
        conclusion: result.conclusion,
        reason: result.reason,
        handoffContext: result.handoffContext,
        approved: true,
        runUrl: currentRunUrl(),
        headSha: expectedHeadSha,
      }));
      approved = true;
      statusPost = false;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        conclusion: "failed",
        shouldApprove: false,
        reason: `approval submission failed: ${message || "unknown error"}`,
        handoffContext: result.handoffContext,
      };
    }
  }
}

const body = formatSelfApprovalBody({
  conclusion: result.conclusion,
  reason: result.reason,
  handoffContext: result.handoffContext,
  approved,
  runUrl: currentRunUrl(),
  headSha: expectedHeadSha,
});
const bodyFile = writeBodyFile(body);
setOutput("conclusion", result.conclusion);
setOutput("approved", String(approved));
setOutput("status_post", String(statusPost));
setOutput("handoff_context", result.handoffContext);
setOutput("reason", result.reason);
setOutput("body_file", bodyFile);
