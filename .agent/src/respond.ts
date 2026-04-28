// Response posting to GitHub surfaces (issues, PRs, discussions).
//
// Uses gh CLI for all API calls, consistent with the local runtime's GitHub helpers.
// Replaces the Octokit-based respond.cjs + post.cjs files.

import { execFileSync } from "node:child_process";
import { postIssueComment, postPrComment } from "./github.js";

const MAX_BUFFER = 10 * 1024 * 1024;

export interface ResponseTarget {
  /** "issue_comment" | "review_comment_reply" | "discussion_comment" */
  responseKind: string;
  /** Issue, PR, or discussion number */
  targetNumber: number;
  /** PR review comment ID (for review_comment_reply) */
  reviewCommentId?: number;
  /** Discussion GraphQL node ID (for discussion_comment) */
  discussionNodeId?: string;
  /** Optional reply-to node ID for threaded discussion replies */
  replyToId?: string;
  /** Repository slug (owner/repo) — used for review comment replies */
  repo?: string;
}

/**
 * Posts a response to the correct GitHub surface based on responseKind.
 */
export function postResponse(target: ResponseTarget, body: string): void {
  if (!body.trim()) {
    throw new Error("Response body is empty");
  }

  switch (target.responseKind) {
    case "issue_comment":
      postIssueComment(target.targetNumber, body, target.repo);
      break;

    case "pr_comment":
      postPrComment(target.targetNumber, body, target.repo);
      break;

    case "review_comment_reply":
      if (!target.reviewCommentId || !target.repo) {
        throw new Error("review_comment_reply requires reviewCommentId and repo");
      }
      replyToReviewComment(
        target.repo,
        target.targetNumber,
        target.reviewCommentId,
        body,
      );
      break;

    case "discussion_comment":
      if (!target.discussionNodeId) {
        throw new Error("discussion_comment requires discussionNodeId");
      }
      postDiscussionComment(target.discussionNodeId, body, target.replyToId);
      break;

    default:
      throw new Error(`Unsupported response kind: ${target.responseKind}`);
  }
}

/**
 * Replies to a PR review comment via REST API.
 */
function replyToReviewComment(
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string,
): void {
  execFileSync(
    "gh",
    [
      "api",
      "--method", "POST",
      `repos/${repo}/pulls/${pullNumber}/comments/${commentId}/replies`,
      "-f", `body=${body}`,
    ],
    { stdio: "pipe", maxBuffer: MAX_BUFFER },
  );
}

/**
 * Posts a comment to a GitHub discussion via GraphQL.
 */
function postDiscussionComment(
  discussionId: string,
  body: string,
  replyToId?: string,
): void {
  let query: string;
  let args: string[];

  if (replyToId) {
    query = `
      mutation($discussionId: ID!, $body: String!, $replyToId: ID!) {
        addDiscussionComment(input: {
          discussionId: $discussionId,
          body: $body,
          replyToId: $replyToId
        }) {
          comment { url }
        }
      }
    `;
    args = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `discussionId=${discussionId}`,
      "-f", `body=${body}`,
      "-f", `replyToId=${replyToId}`,
    ];
  } else {
    query = `
      mutation($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: {
          discussionId: $discussionId,
          body: $body
        }) {
          comment { url }
        }
      }
    `;
    args = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `discussionId=${discussionId}`,
      "-f", `body=${body}`,
    ];
  }

  execFileSync("gh", args, { stdio: "pipe", maxBuffer: MAX_BUFFER });
}
