// CLI: post a status comment to an issue or PR.
// Usage: node .agent/dist/cli/post-comment.js
// Env: COMMENT_TARGET (issue or pr), TARGET_NUMBER, ROUTE, STATUS,
//      RESPONSE_FILE (optional), BRANCH, PR_URL, REQUESTED_BY,
//      APPROVAL_COMMENT_URL, CANCELLED_BY, AGENT_COLLAPSE_OLD_REVIEWS
// Outputs: status

import { readFileSync } from "node:fs";
import { fetchPrMeta, postIssueComment, postPrComment } from "../github.js";
import { tryMergeProgressFinalComment } from "../progress-final-comment.js";
import {
  collapsePreviousFixPrComments,
  collapsePreviousReviewSummaries,
} from "../review-summary-minimize.js";
import {
  formatAddRubricsComment,
  formatImplementComment,
  formatFixPrComment,
  formatReviewComment,
  appendRunDisplayFooter,
  isExplainedAddRubricsNoop,
  normalizeImplementationResponse,
  summaryFromAgentResponse,
  type RunStatus,
} from "../response.js";
import { setOutput } from "../output.js";
import { formatSessionRestoreNotice } from "../session-bundle.js";

const target = process.env.COMMENT_TARGET || "issue"; // "issue" or "pr"
const targetNumber = Number(process.env.TARGET_NUMBER || process.env.ISSUE_NUMBER || process.env.PR_NUMBER);
const route = process.env.ROUTE || "implement";
const status = (process.env.STATUS || "failed") as RunStatus;
const responseFile = process.env.RESPONSE_FILE || "";
const branch = process.env.BRANCH || "";
const prUrl = process.env.PR_URL || "";
const requestedBy = process.env.REQUESTED_BY || "";
const approvalCommentUrl = process.env.APPROVAL_COMMENT_URL || "";
const cancelledBy = process.env.CANCELLED_BY || "";
const resumeStatus = process.env.RESUME_STATUS || "";
const modelDisplay = process.env.MODEL_DISPLAY || process.env.AGENT_RUN_DISPLAY || "";
const repo = process.env.GITHUB_REPOSITORY || "";
const progressFinalCommentMode = process.env.AGENT_PROGRESS_FINAL_COMMENT_MODE || "";
const progressCommentId = process.env.AGENT_PROGRESS_COMMENT_ID || process.env.PROGRESS_COMMENT_ID || "";
const collapseOldReviews = !["false", "0", "no", "off"].includes(
  (process.env.AGENT_COLLAPSE_OLD_REVIEWS || "").trim().toLowerCase(),
);

let rawResponse = "";
if (responseFile) {
  try { rawResponse = readFileSync(responseFile, "utf8"); } catch { /* ok */ }
}
const summary = summaryFromAgentResponse(route, rawResponse);

let body: string;

if (route === "review") {
  let reviewedHeadSha = "";
  const capturedReviewedHeadSha = String(process.env.REVIEWED_HEAD_SHA || "").trim();
  if (capturedReviewedHeadSha && target === "pr" && repo && targetNumber > 0) {
    try {
      const currentHeadSha = fetchPrMeta(targetNumber, repo).headOid;
      if (currentHeadSha === capturedReviewedHeadSha) {
        reviewedHeadSha = capturedReviewedHeadSha;
      } else {
        console.warn("Review synthesis head marker omitted because the PR head changed during review.");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Review synthesis head marker omitted because PR metadata could not be read: ${message}`);
    }
  }
  body = formatReviewComment({
    synthesisBody: summary,
    requestedBy: requestedBy || undefined,
    approvalCommentUrl: approvalCommentUrl || undefined,
    reviewedHeadSha: reviewedHeadSha || undefined,
  });
} else if (route === "fix-pr") {
  body = formatFixPrComment({
    status,
    summary,
    branch,
    requestedBy: requestedBy || undefined,
    approvalCommentUrl: approvalCommentUrl || undefined,
    cancelledBy: cancelledBy || undefined,
  });
} else if (route === "add-rubrics") {
  const parsed = normalizeImplementationResponse(rawResponse);
  body = formatAddRubricsComment({
    status,
    summary: parsed.summary,
    branch: branch || undefined,
    prUrl: prUrl || undefined,
    approvalCommentUrl: approvalCommentUrl || undefined,
    explainedNoop: isExplainedAddRubricsNoop(route, parsed),
    cancelledBy: cancelledBy || undefined,
  });
} else {
  // implement or other
  const parsed = route === "implement"
    ? normalizeImplementationResponse(rawResponse)
    : { summary, prTitle: "", prBody: "" };
  body = formatImplementComment({
    status,
    summary: parsed.summary,
    branch: branch || undefined,
    prUrl: prUrl || undefined,
    approvalCommentUrl: approvalCommentUrl || undefined,
    cancelledBy: cancelledBy || undefined,
  });
}

const continuityNote = formatSessionRestoreNotice({ resumeStatus, runStatus: status });
if (continuityNote) {
  body = `> ${continuityNote}\n\n${body}`;
}

const bodyWithFooter = appendRunDisplayFooter(body, modelDisplay);

if (target === "pr") {
  if (route === "review" && collapseOldReviews) {
    try {
      const collapsed = collapsePreviousReviewSummaries({ repo, prNumber: targetNumber });
      if (collapsed > 0) {
        console.log(`Collapsed ${collapsed} previous AI review synthesis comment(s).`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `Failed to collapse previous AI review synthesis comments for ${repo}#${targetNumber}: ${message}`,
      );
    }
  }
  if (route === "fix-pr" && collapseOldReviews) {
    try {
      const collapsed = collapsePreviousFixPrComments({ repo, prNumber: targetNumber });
      if (collapsed > 0) {
        console.log(`Collapsed ${collapsed} previous fix-pr status comment(s).`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `Failed to collapse previous fix-pr status comments for ${repo}#${targetNumber}: ${message}`,
      );
    }
  }
  const merged = tryMergeProgressFinalComment({
    repo,
    commentId: progressCommentId,
    mode: progressFinalCommentMode,
    finalBody: body,
    footer: modelDisplay,
  });
  if (!merged) {
    postPrComment(targetNumber, bodyWithFooter);
  }
} else {
  const merged = tryMergeProgressFinalComment({
    repo,
    commentId: progressCommentId,
    mode: progressFinalCommentMode,
    finalBody: body,
    footer: modelDisplay,
  });
  if (!merged) {
    postIssueComment(targetNumber, bodyWithFooter);
  }
}

setOutput("comment_posted", "true");
