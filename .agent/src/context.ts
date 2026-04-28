// Normalizes supported GitHub event payloads into the portal's common
// trigger shape so later steps can gate on associations, mentions, reactions,
// and response targets without branching on every event type again.

import { hasLiveMention } from "./mentions.js";

export const DEFAULT_TRUSTED_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
]);

export const DEFAULT_MENTION = "@sepo-agent";

export interface PortalEventContext {
  body: string;
  sourceKind: string;
  targetKind: string;
  targetNumber: string;
  targetUrl: string;
  reactionSubjectId: string;
  responseKind: string;
  sourceCommentId?: string;
  sourceCommentUrl?: string;
  reviewCommentId?: string;
  discussionNodeId?: string;
  discussionCommentNodeId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

function joinTitleAndBody(title: string, body: string): string {
  return [title, body].filter(Boolean).join("\n\n");
}

function getPreviousEditedBody(eventName: string, payload: Payload): string | null {
  if (payload.action !== "edited") {
    return null;
  }

  if (eventName === "issues") {
    const title = payload.changes?.title?.from ?? payload.issue?.title ?? "";
    const body = payload.changes?.body?.from ?? payload.issue?.body ?? "";
    return joinTitleAndBody(title, body);
  }

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const title = payload.changes?.title?.from ?? payload.pull_request?.title ?? "";
    const body = payload.changes?.body?.from ?? payload.pull_request?.body ?? "";
    return joinTitleAndBody(title, body);
  }

  if (eventName === "discussion") {
    const title = payload.changes?.title?.from ?? payload.discussion?.title ?? "";
    const body = payload.changes?.body?.from ?? payload.discussion?.body ?? "";
    return joinTitleAndBody(title, body);
  }

  if (eventName === "issue_comment") {
    return payload.changes?.body?.from ?? payload.comment?.body ?? "";
  }

  if (eventName === "pull_request_review_comment") {
    return payload.changes?.body?.from ?? payload.comment?.body ?? "";
  }

  if (eventName === "pull_request_review") {
    return payload.changes?.body?.from ?? payload.review?.body ?? "";
  }

  if (eventName === "discussion_comment") {
    return payload.changes?.body?.from ?? payload.comment?.body ?? "";
  }

  return null;
}

/**
 * Returns the author association field for the current trigger shape.
 */
export function getAuthorAssociation(eventName: string, payload: Payload): string {
  if (eventName === "issue_comment") {
    return payload.comment?.author_association || "NONE";
  }
  if (eventName === "pull_request_review_comment") {
    return payload.comment?.author_association || "NONE";
  }
  if (eventName === "pull_request_review") {
    return payload.review?.author_association || "NONE";
  }
  if (eventName === "issues") {
    return payload.issue?.author_association || "NONE";
  }
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return payload.pull_request?.author_association || "NONE";
  }
  if (eventName === "discussion") {
    return (
      payload.discussion?.authorAssociation ||
      payload.discussion?.author_association ||
      "NONE"
    );
  }
  if (eventName === "discussion_comment") {
    return (
      payload.comment?.authorAssociation ||
      payload.comment?.author_association ||
      "NONE"
    );
  }
  return "NONE";
}

/**
 * Extracts the requesting user's login from the event payload.
 */
export function getRequestedBy(eventName: string, payload: Payload): string {
  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    return payload.comment?.user?.login || "";
  }
  if (eventName === "pull_request_review") {
    return payload.review?.user?.login || "";
  }
  if (eventName === "issues") {
    return payload.issue?.user?.login || "";
  }
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return payload.pull_request?.user?.login || "";
  }
  if (eventName === "discussion") {
    return payload.discussion?.user?.login || "";
  }
  if (eventName === "discussion_comment") {
    return payload.comment?.user?.login || "";
  }
  return "";
}

/**
 * Extracts a normalized portal event context from a supported webhook payload.
 */
export function extractEventContext(
  eventName: string,
  payload: Payload,
): PortalEventContext {
  if (eventName === "issues") {
    const title = payload.issue?.title || "";
    const body = payload.issue?.body || "";
    return {
      body: joinTitleAndBody(title, body),
      sourceKind: "issue",
      targetKind: "issue",
      targetNumber: String(payload.issue?.number || ""),
      targetUrl: payload.issue?.html_url || "",
      reactionSubjectId: payload.issue?.node_id || "",
      responseKind: "issue_comment",
    };
  }

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const title = payload.pull_request?.title || "";
    const body = payload.pull_request?.body || "";
    return {
      body: joinTitleAndBody(title, body),
      sourceKind: "pull_request",
      targetKind: "pull_request",
      targetNumber: String(payload.pull_request?.number || ""),
      targetUrl: payload.pull_request?.html_url || "",
      reactionSubjectId: payload.pull_request?.node_id || "",
      responseKind: "issue_comment",
    };
  }

  if (eventName === "issue_comment") {
    return {
      body: payload.comment?.body || "",
      sourceKind: "issue_comment",
      sourceCommentId: String(payload.comment?.id || ""),
      sourceCommentUrl: payload.comment?.html_url || "",
      targetKind: payload.issue?.pull_request ? "pull_request" : "issue",
      targetNumber: String(payload.issue?.number || ""),
      targetUrl: payload.issue?.html_url || "",
      reactionSubjectId: payload.comment?.node_id || "",
      responseKind: "issue_comment",
    };
  }

  if (eventName === "pull_request_review_comment") {
    return {
      body: payload.comment?.body || "",
      sourceKind: "pull_request_review_comment",
      sourceCommentId: String(payload.comment?.id || ""),
      sourceCommentUrl: payload.comment?.html_url || "",
      targetKind: "pull_request",
      targetNumber: String(payload.pull_request?.number || ""),
      targetUrl: payload.pull_request?.html_url || "",
      reactionSubjectId: payload.comment?.node_id || "",
      responseKind: "review_comment_reply",
      reviewCommentId: String(payload.comment?.id || ""),
    };
  }

  if (eventName === "pull_request_review") {
    return {
      body: payload.review?.body || "",
      sourceKind: "pull_request_review",
      sourceCommentId: String(payload.review?.id || ""),
      sourceCommentUrl: payload.review?.html_url || "",
      targetKind: "pull_request",
      targetNumber: String(payload.pull_request?.number || ""),
      targetUrl: payload.pull_request?.html_url || "",
      reactionSubjectId: payload.review?.node_id || "",
      responseKind: "issue_comment",
    };
  }

  if (eventName === "discussion") {
    const title = payload.discussion?.title || "";
    const body = payload.discussion?.body || "";
    return {
      body: joinTitleAndBody(title, body),
      sourceKind: "discussion",
      targetKind: "discussion",
      targetNumber: String(payload.discussion?.number || ""),
      targetUrl:
        payload.discussion?.html_url || payload.discussion?.url || "",
      reactionSubjectId: payload.discussion?.node_id || "",
      responseKind: "discussion_comment",
      discussionNodeId: payload.discussion?.node_id || "",
    };
  }

  if (eventName === "discussion_comment") {
    return {
      body: payload.comment?.body || "",
      sourceKind: "discussion_comment",
      targetKind: "discussion",
      targetNumber: String(payload.discussion?.number || ""),
      targetUrl:
        payload.discussion?.html_url || payload.discussion?.url || "",
      reactionSubjectId: payload.comment?.node_id || "",
      responseKind: "discussion_comment",
      discussionNodeId: payload.discussion?.node_id || "",
      discussionCommentNodeId: payload.comment?.node_id || "",
    };
  }

  throw new Error(`Unsupported event for agent mention: ${eventName}`);
}

/**
 * Filters out bot-authored events before the portal spends effort on them.
 */
export function shouldSkipSender(payload: Payload): boolean {
  const senderLogin = payload.sender?.login || "";
  const senderType = payload.sender?.type || "";
  return (
    senderType === "Bot" ||
    /\[bot\]$/i.test(senderLogin) ||
    senderLogin === "github-actions"
  );
}

/**
 * Checks whether this payload should trigger a mention-based response.
 * Edited events only trigger when the live mention state changes false -> true.
 */
export function shouldRespondToMention(
  eventName: string,
  payload: Payload,
  mention: string,
): boolean {
  const currentBody = extractEventContext(eventName, payload).body;
  if (!hasLiveMention(currentBody, mention)) {
    return false;
  }

  const previousBody = getPreviousEditedBody(eventName, payload);
  if (previousBody === null) {
    return true;
  }

  return !hasLiveMention(previousBody, mention);
}

// Re-export for convenient access from context module consumers
export { hasLiveMention };
