// CLI: post a status comment to an issue or PR.
// Usage: node .agent/dist/cli/post-comment.js
// Env: COMMENT_TARGET (issue or pr), TARGET_NUMBER, ROUTE, STATUS,
//      RESPONSE_FILE (optional), BRANCH, PR_URL, REQUESTED_BY,
//      APPROVAL_COMMENT_URL, CURRENT_REVIEW_STARTED_AT_MS,
//      AGENT_COLLAPSE_OLD_REVIEWS
// Outputs: status

import { readFileSync } from "node:fs";
import { postIssueComment, postPrComment } from "../github.js";
import {
  collapsePreviousFixPrComments,
  collapsePreviousReviewSummaries,
} from "../review-summary-minimize.js";
import {
  formatImplementComment,
  formatFixPrComment,
  formatReviewComment,
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
const resumeStatus = process.env.RESUME_STATUS || "";
const repo = process.env.GITHUB_REPOSITORY || "";
const collapseOldReviews = !["false", "0", "no", "off"].includes(
  (process.env.AGENT_COLLAPSE_OLD_REVIEWS || "").trim().toLowerCase(),
);

function readCurrentReviewStartedAtMs(): number | undefined {
  const raw = (process.env.CURRENT_REVIEW_STARTED_AT_MS || "").trim();
  if (!raw) {
    console.warn(
      "CURRENT_REVIEW_STARTED_AT_MS is missing; inline review comment cleanup will be skipped.",
    );
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `CURRENT_REVIEW_STARTED_AT_MS is malformed (${JSON.stringify(raw)}); inline review comment cleanup will be skipped.`,
    );
    return undefined;
  }

  return value;
}

let rawResponse = "";
if (responseFile) {
  try { rawResponse = readFileSync(responseFile, "utf8"); } catch { /* ok */ }
}
const summary = summaryFromAgentResponse(route, rawResponse);

let body: string;

if (route === "review") {
  body = formatReviewComment({
    synthesisBody: summary,
    requestedBy: requestedBy || undefined,
    approvalCommentUrl: approvalCommentUrl || undefined,
  });
} else if (route === "fix-pr") {
  body = formatFixPrComment({
    status,
    summary,
    branch,
    requestedBy: requestedBy || undefined,
    approvalCommentUrl: approvalCommentUrl || undefined,
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
  });
}

const continuityNote = formatSessionRestoreNotice({ resumeStatus, runStatus: status });
if (continuityNote) {
  body = `> ${continuityNote}\n\n${body}`;
}

if (target === "pr") {
  if (route === "review" && collapseOldReviews) {
    try {
      const collapsed = collapsePreviousReviewSummaries({
        repo,
        prNumber: targetNumber,
        currentReviewStartedAtMs: readCurrentReviewStartedAtMs(),
      });
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
  postPrComment(targetNumber, body);
} else {
  postIssueComment(targetNumber, body);
}

setOutput("comment_posted", "true");
