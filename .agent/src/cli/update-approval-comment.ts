// CLI: update an approval request comment to mark it as satisfied.
// Usage: node .agent/dist/cli/update-approval-comment.js
// Env: REQUEST_COMMENT_ID, REQUEST_COMMENT_BODY, IS_DISCUSSION,
//      ROUTE, WORKFLOW, CREATED_ISSUE_URL, RUN_URL, APPROVER,
//      GITHUB_REPOSITORY

import { execFileSync } from "node:child_process";
import { markApprovalRequestSatisfied } from "../approval.js";
import { updateDiscussionComment } from "../discussion.js";

const commentId = process.env.REQUEST_COMMENT_ID || "";
const commentBody = process.env.REQUEST_COMMENT_BODY || "";
const isDiscussion = process.env.IS_DISCUSSION === "true";
const route = process.env.ROUTE || "";
const workflow = process.env.WORKFLOW || "";
const createdIssueUrl = process.env.CREATED_ISSUE_URL || "";
const runUrl = process.env.RUN_URL || "";
const approver = process.env.APPROVER || "";
const repo = process.env.GITHUB_REPOSITORY || "";

if (!commentId || !commentBody) {
  console.error("Missing REQUEST_COMMENT_ID or REQUEST_COMMENT_BODY");
  process.exitCode = 1;
} else {
  const newBody = markApprovalRequestSatisfied(commentBody, approver, {
    route: route || undefined,
    workflow: workflow || undefined,
    issueUrl: createdIssueUrl || undefined,
    runUrl: runUrl || undefined,
  });

  if (isDiscussion) {
    updateDiscussionComment(commentId, newBody);
  } else {
    execFileSync(
      "gh",
      [
        "api", "--method", "PATCH",
        `repos/${repo}/issues/comments/${commentId}`,
        "-f", `body=${newBody}`,
      ],
      { stdio: "pipe", maxBuffer: 10 * 1024 * 1024 },
    );
  }
}
