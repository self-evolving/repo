// CLI: post a response to the correct GitHub surface.
// Usage: node .agent/dist/cli/post-response.js
// Env: BODY_FILE, RESPONSE_KIND, TARGET_NUMBER, REVIEW_COMMENT_ID,
//      DISCUSSION_ID, REPLY_TO_ID, GITHUB_REPOSITORY,
//      AGENT_COLLAPSE_OLD_REVIEWS

import { readFileSync } from "node:fs";
import { upsertPrCommentByMarker } from "../github.js";
import { tryMergeProgressFinalComment } from "../progress-final-comment.js";
import { postResponse } from "../respond.js";
import {
  collapsePreviousRubricsReviews,
  isRubricsReviewBody,
} from "../review-summary-minimize.js";
import { SELF_APPROVAL_STATUS_MARKER } from "../self-approval.js";
import { SELF_MERGE_STATUS_MARKER } from "../self-merge.js";
import { formatSessionRestoreNotice } from "../session-bundle.js";
import { appendRunDisplayFooter } from "../response.js";

const bodyFile = process.env.BODY_FILE || "";
const responseKind = process.env.RESPONSE_KIND || "issue_comment";
const targetNumber = Number(process.env.TARGET_NUMBER || "0");
const reviewCommentId = Number(process.env.REVIEW_COMMENT_ID || "0") || undefined;
const discussionNodeId = process.env.DISCUSSION_ID || undefined;
const replyToId = process.env.REPLY_TO_ID || undefined;
const repo = process.env.GITHUB_REPOSITORY || undefined;
const resumeStatus = process.env.RESUME_STATUS || "";
const runStatus = process.env.STATUS || "success";
const modelDisplay = process.env.MODEL_DISPLAY || process.env.AGENT_RUN_DISPLAY || "";
const progressFinalCommentMode = process.env.AGENT_PROGRESS_FINAL_COMMENT_MODE || "";
const progressCommentId = process.env.AGENT_PROGRESS_COMMENT_ID || process.env.PROGRESS_COMMENT_ID || "";
const collapseOldReviews = !["false", "0", "no", "off"].includes(
  (process.env.AGENT_COLLAPSE_OLD_REVIEWS || "").trim().toLowerCase(),
);

let body = "";
if (bodyFile) {
  try {
    body = readFileSync(bodyFile, "utf8");
  } catch {
    console.error(`Could not read body file: ${bodyFile}`);
  }
}

if (!body.trim()) {
  body = "I was unable to produce a response. Please check the workflow logs.";
}

const continuityNote = formatSessionRestoreNotice({ resumeStatus, runStatus });
if (continuityNote) {
  body = `> ${continuityNote}\n\n${body}`;
}

const bodyWithFooter = appendRunDisplayFooter(body, modelDisplay);

let posted = false;
let markerUpsertFailed = false;
const markerUpsert = body.includes(SELF_APPROVAL_STATUS_MARKER)
  ? { marker: SELF_APPROVAL_STATUS_MARKER, label: "self-approval" }
  : body.includes(SELF_MERGE_STATUS_MARKER)
    ? { marker: SELF_MERGE_STATUS_MARKER, label: "self-merge" }
    : null;
if (
  responseKind === "pr_comment" &&
  repo &&
  targetNumber > 0 &&
  markerUpsert
) {
  try {
    const action = upsertPrCommentByMarker(targetNumber, repo, markerUpsert.marker, bodyWithFooter);
    console.log(`${action === "updated" ? "Updated" : "Created"} ${markerUpsert.label} status comment.`);
    posted = true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Failed to upsert ${markerUpsert.label} status comment for ${repo}#${targetNumber}: ${message}`,
    );
    markerUpsertFailed = true;
    process.exitCode = 1;
  }
}

if (
  !posted &&
  !markerUpsertFailed &&
  responseKind === "pr_comment" &&
  repo &&
  targetNumber > 0 &&
  collapseOldReviews &&
  isRubricsReviewBody(body)
) {
  try {
    const collapsed = collapsePreviousRubricsReviews({ repo, prNumber: targetNumber });
    if (collapsed > 0) {
      console.log(`Collapsed ${collapsed} previous rubrics review comment(s).`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `Failed to collapse previous rubrics review comments for ${repo}#${targetNumber}: ${message}`,
    );
  }
}

if (
  !posted &&
  !markerUpsertFailed &&
  (responseKind === "issue_comment" || responseKind === "pr_comment") &&
  repo
) {
  posted = tryMergeProgressFinalComment({
    repo,
    commentId: progressCommentId,
    mode: progressFinalCommentMode,
    finalBody: body,
    footer: modelDisplay,
  });
}

if (!posted && !markerUpsertFailed) {
  postResponse(
    { responseKind, targetNumber, reviewCommentId, discussionNodeId, replyToId, repo },
    bodyWithFooter,
  );
}
