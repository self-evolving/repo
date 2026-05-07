// CLI: resolve a self-approval agent response and optionally approve a PR.
// Env: RESPONSE_FILE, GITHUB_REPOSITORY, TARGET_NUMBER, TARGET_KIND,
//      EXPECTED_HEAD_SHA, AGENT_ALLOW_SELF_APPROVE
// Outputs: conclusion, approved, should_orchestrate, handoff_context,
//          reason, body_file

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchAuthenticatedActorLogin,
  fetchIssueCommentRecords,
  fetchPrMeta,
  gh,
} from "../github.js";
import { setOutput } from "../output.js";
import {
  envFlagEnabled,
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

const repo = process.env.GITHUB_REPOSITORY || "";
const prNumber = Number(process.env.TARGET_NUMBER || process.env.PR_NUMBER || "");
const targetKind = process.env.TARGET_KIND || "pull_request";
const expectedHeadSha = process.env.EXPECTED_HEAD_SHA || "";
const allowSelfApprove = envFlagEnabled(process.env.AGENT_ALLOW_SELF_APPROVE);
const decision = parseSelfApprovalDecision(readResponse());

let prState = "";
let currentHeadSha = "";
let metadataReadReason = "";
let approvalProvenanceTrusted = false;
let approvalProvenanceReason = "missing trusted review synthesis for self-approval";
if (repo && prNumber) {
  try {
    const meta = fetchPrMeta(prNumber, repo);
    prState = meta.state;
    currentHeadSha = meta.headOid;
  } catch {
    metadataReadReason = "could not read pull request metadata during self-approval resolution";
    prState = "";
    currentHeadSha = "";
  }

  try {
    const provenance = evaluateSelfApprovalProvenance({
      comments: fetchIssueCommentRecords(prNumber, repo),
      trustedActorLogin: fetchAuthenticatedActorLogin(),
      expectedHeadSha,
    });
    approvalProvenanceTrusted = provenance.trusted;
    approvalProvenanceReason = provenance.reason;
  } catch {
    approvalProvenanceTrusted = false;
    approvalProvenanceReason = "could not read trusted review synthesis";
  }
}

let result = metadataReadReason
  ? {
    conclusion: "failed" as const,
    shouldApprove: false,
    shouldOrchestrate: false,
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
    approvalProvenanceTrusted,
    approvalProvenanceReason,
  });
let approved = false;
if (result.shouldApprove) {
  try {
    submitApproval(repo, prNumber, expectedHeadSha, formatSelfApprovalBody({
      conclusion: result.conclusion,
      reason: result.reason,
      handoffContext: result.handoffContext,
      approved: true,
      runUrl: currentRunUrl(),
    }));
    approved = true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      conclusion: "failed",
      shouldApprove: false,
      shouldOrchestrate: false,
      reason: `approval submission failed: ${message || "unknown error"}`,
      handoffContext: result.handoffContext,
    };
  }
}

const body = formatSelfApprovalBody({
  conclusion: result.conclusion,
  reason: result.reason,
  handoffContext: result.handoffContext,
  approved,
  runUrl: currentRunUrl(),
});
const bodyFile = writeBodyFile(body);
setOutput("conclusion", result.conclusion);
setOutput("approved", String(approved));
setOutput("should_orchestrate", String(result.shouldOrchestrate));
setOutput("handoff_context", result.handoffContext);
setOutput("reason", result.reason);
setOutput("body_file", bodyFile);
