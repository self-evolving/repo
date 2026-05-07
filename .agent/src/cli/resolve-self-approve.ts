// CLI: resolve a self-approval agent response and optionally approve a PR.
// Env: RESPONSE_FILE, GITHUB_REPOSITORY, TARGET_NUMBER, TARGET_KIND,
//      EXPECTED_HEAD_SHA, AGENT_ALLOW_SELF_APPROVE
// Outputs: conclusion, approved, should_orchestrate, handoff_context,
//          reason, body_file

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPrMeta, gh } from "../github.js";
import { setOutput } from "../output.js";
import {
  envFlagEnabled,
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
if (repo && prNumber) {
  try {
    const meta = fetchPrMeta(prNumber, repo);
    prState = meta.state;
    currentHeadSha = meta.headOid;
  } catch {
    prState = "";
    currentHeadSha = "";
  }
}

const result = resolveSelfApproval({
  allowSelfApprove,
  targetKind,
  prState,
  expectedHeadSha,
  currentHeadSha,
  decision,
});

const body = formatSelfApprovalBody({
  conclusion: result.conclusion,
  reason: result.reason,
  handoffContext: result.handoffContext,
  approved: result.shouldApprove,
  runUrl: currentRunUrl(),
});

let approved = false;
if (result.shouldApprove) {
  submitApproval(repo, prNumber, expectedHeadSha, body);
  approved = true;
}

const bodyFile = writeBodyFile(body);
setOutput("conclusion", result.conclusion);
setOutput("approved", String(approved));
setOutput("should_orchestrate", String(result.shouldOrchestrate));
setOutput("handoff_context", result.handoffContext);
setOutput("reason", result.reason);
setOutput("body_file", bodyFile);
