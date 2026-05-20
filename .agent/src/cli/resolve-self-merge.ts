// CLI: preflight and perform deterministic self-merge for an approved PR.
// Env: GITHUB_REPOSITORY, TARGET_NUMBER, TARGET_KIND, AGENT_ALLOW_SELF_MERGE
// Outputs: conclusion, merged, auto_merge_enabled, status_post, reason, body_file

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enablePullRequestAutoMerge,
  fetchAuthenticatedActorLogin,
  fetchIssueCommentRecords,
  fetchPrMergeMeta,
  fetchPrReviewRecords,
  markPullRequestReady,
  mergePullRequest,
} from "../github.js";
import { setOutput } from "../output.js";
import { envFlagEnabled } from "../self-approval.js";
import {
  evaluateSelfMergeApproval,
  formatSelfMergeBody,
  resolveSelfMerge,
  type SelfMergeApprovalResult,
  type SelfMergeResolveResult,
} from "../self-merge.js";

function writeBodyFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sepo-self-merge-"));
  const file = join(dir, "body.md");
  writeFileSync(file, body, "utf8");
  return file;
}

function currentRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL || "";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  return server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : "";
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

function normalizeTargetKind(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const repo = process.env.GITHUB_REPOSITORY || "";
const prNumber = Number(process.env.TARGET_NUMBER || process.env.PR_NUMBER || "");
const targetKind = process.env.TARGET_KIND || "pull_request";
const allowSelfMerge = envFlagEnabled(process.env.AGENT_ALLOW_SELF_MERGE);

function resolveCurrentSelfMerge(): {
  result: SelfMergeResolveResult;
  verifiedHeadSha: string;
} {
  if (!allowSelfMerge || normalizeTargetKind(targetKind) !== "pull_request" || !repo || !prNumber) {
    return {
      verifiedHeadSha: "",
      result: resolveSelfMerge({
        allowSelfMerge,
        targetKind,
        prState: "",
        isDraft: false,
        currentHeadSha: "",
        reviewDecision: "",
        mergeStateStatus: "",
        mergeable: "",
        statusChecks: [],
        approval: {
          approved: false,
          approvedHeadSha: "",
          reason: repo && prNumber ? "missing current-head self-approval" : "missing pull request target",
        },
      }),
    };
  }

  try {
    const meta = fetchPrMergeMeta(prNumber, repo);
    let approval: SelfMergeApprovalResult;
    let reviews: ReturnType<typeof fetchPrReviewRecords> = [];
    let comments: ReturnType<typeof fetchIssueCommentRecords> = [];
    let reviewReadFailed = false;
    let commentReadFailed = false;
    try {
      reviews = fetchPrReviewRecords(prNumber, repo);
    } catch {
      reviewReadFailed = true;
    }
    try {
      comments = fetchIssueCommentRecords(prNumber, repo);
    } catch {
      commentReadFailed = true;
    }
    if (reviewReadFailed && commentReadFailed) {
      approval = {
        approved: false,
        approvedHeadSha: "",
        reason: "could not read current-head self-approval reviews or status comments",
      };
    } else {
      approval = evaluateSelfMergeApproval({
        reviews,
        comments,
        trustedActorLogin: fetchAuthenticatedActorLogin(),
        currentHeadSha: meta.headOid,
      });
      if (!approval.approved && reviewReadFailed) {
        approval = { ...approval, reason: `${approval.reason}; could not read self-approval reviews` };
      }
      if (!approval.approved && commentReadFailed) {
        approval = { ...approval, reason: `${approval.reason}; could not read self-approval status comments` };
      }
    }

    const result = resolveSelfMerge({
      allowSelfMerge,
      targetKind,
      prState: meta.state,
      isDraft: meta.isDraft,
      currentHeadSha: meta.headOid,
      reviewDecision: meta.reviewDecision,
      mergeStateStatus: meta.mergeStateStatus,
      mergeable: meta.mergeable,
      autoMergeRequestExists: meta.autoMergeRequestExists,
      statusChecks: meta.statusChecks,
      approval,
    });
    return {
      verifiedHeadSha: approval.approved ? approval.approvedHeadSha || meta.headOid : "",
      result,
    };
  } catch {
    return {
      verifiedHeadSha: "",
      result: {
        conclusion: "failed",
        nextStep: "none",
        markReady: false,
        reason: "could not read pull request metadata during self-merge preflight",
      },
    };
  }
}

let { result, verifiedHeadSha } = resolveCurrentSelfMerge();
if (result.markReady) {
  try {
    markPullRequestReady(prNumber, repo);
    ({ result, verifiedHeadSha } = resolveCurrentSelfMerge());
  } catch (err: unknown) {
    result = {
      conclusion: "failed",
      nextStep: "none",
      markReady: false,
      reason: `mark ready failed: ${errorText(err) || "unknown error"}`,
    };
  }
}

if (result.nextStep === "merge") {
  try {
    mergePullRequest(prNumber, repo, verifiedHeadSha);
    result = { ...result, conclusion: "merged" };
  } catch (err: unknown) {
    result = {
      conclusion: "failed",
      nextStep: "none",
      markReady: false,
      reason: `merge failed: ${errorText(err) || "unknown error"}`,
    };
  }
} else if (result.nextStep === "enable_auto_merge") {
  try {
    enablePullRequestAutoMerge(prNumber, repo, verifiedHeadSha);
    result = { ...result, conclusion: "auto_merge_enabled" };
  } catch (err: unknown) {
    result = {
      conclusion: "failed",
      nextStep: "none",
      markReady: false,
      reason: `auto-merge enable failed: ${errorText(err) || "unknown error"}`,
    };
  }
}

const bodyFile = writeBodyFile(formatSelfMergeBody({
  conclusion: result.conclusion,
  reason: result.reason,
  runUrl: currentRunUrl(),
}));
setOutput("conclusion", result.conclusion);
setOutput("merged", String(result.conclusion === "merged"));
setOutput("auto_merge_enabled", String(result.conclusion === "auto_merge_enabled"));
setOutput("status_post", "true");
setOutput("reason", result.reason);
setOutput("body_file", bodyFile);
