// CLI: create or reuse an implementation tracking issue for non-issue targets.
// Usage: node .agent/dist/cli/ensure-implementation-tracking.js

import { ensureImplementationTrackingIssueForTarget } from "../implementation-tracking.js";
import { setOutput } from "../output.js";

function env(name: string): string {
  return String(process.env[name] || "").trim();
}

const result = ensureImplementationTrackingIssueForTarget({
  repo: env("GITHUB_REPOSITORY"),
  targetKind: env("TARGET_KIND"),
  targetNumber: env("TARGET_NUMBER"),
  sourceRunId: env("SOURCE_RUN_ID") || env("GITHUB_RUN_ID"),
  trackingScope: env("TRACKING_SCOPE") || "explicit",
  nextRound: env("IMPLEMENTATION_TRACKING_NEXT_ROUND"),
  issueTitle: env("ISSUE_TITLE"),
  issueBody: process.env.ISSUE_BODY || "",
  sourceKind: env("SOURCE_KIND"),
  targetUrl: env("TARGET_URL"),
  requestText: env("REQUEST_TEXT"),
  baseBranch: env("BASE_BRANCH"),
  basePr: env("BASE_PR"),
  discussionId: env("DISCUSSION_ID"),
  responseKind: env("RESPONSE_KIND"),
  reviewCommentId: env("REVIEW_COMMENT_ID"),
  replyToId: env("REPLY_TO_ID"),
  linkBackLabel: env("LINK_BACK_LABEL") || "this request",
});

setOutput("issue_number", result.issueNumber);
setOutput("issue_url", result.issueUrl);
setOutput("created", String(result.created));
setOutput("reused", String(result.reused));
