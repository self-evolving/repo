// Helpers for encoding, finding, and resolving comment-based approval requests
// left by the portal workflow before dispatching heavier follow-up workflows.

import { DEFAULT_MENTION } from "./context.js";
import { escapeRegex, stripNonLiveMentions } from "./mentions.js";

const APPROVAL_MARKER_RE =
  /<!--\s*sepo-agent-request\s+base64:([A-Za-z0-9_-]+)\s*-->/i;
const APPROVAL_STATUS_RE = /<!--\s*sepo-agent-approved\s*-->/i;

export interface PendingApproval {
  comment: { id: string | number; body: string; created_at: string };
  request: Record<string, unknown>;
}

export interface ApprovalCommand {
  requestId: string;
}

function buildApprovalCommandRegex(mention: string): RegExp | null {
  const trimmedMention = String(mention || "").trim();
  if (!trimmedMention) {
    return null;
  }

  return new RegExp(
    `(?:^|\\s)${escapeRegex(trimmedMention)}\\s+\\/approve\\s+(req-[a-z0-9-]{4,})(?=$|\\s|[.!?])`,
    "i",
  );
}

function encodeApprovalMarkerPayload(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

function decodeApprovalMarkerPayload(payload: string): Record<string, unknown> {
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Encodes workflow dispatch metadata into a hidden HTML marker inside a comment.
 */
export function buildApprovalRequestMarker(data: Record<string, unknown>): string {
  return `<!-- sepo-agent-request base64:${encodeApprovalMarkerPayload(data)} -->`;
}

/**
 * Parses the hidden approval marker from a comment body when present.
 */
export function parseApprovalRequestMarker(
  body: string,
): Record<string, unknown> | null {
  const text = String(body || "");
  const encodedMatch = text.match(APPROVAL_MARKER_RE);
  try {
    return encodedMatch ? decodeApprovalMarkerPayload(encodedMatch[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Reports whether the approval-request comment has already been resolved.
 */
export function isApprovalRequestAlreadySatisfied(body: string): boolean {
  return APPROVAL_STATUS_RE.test(String(body || ""));
}

/**
 * Reports whether a comment is an agent-managed approval request/status comment.
 */
export function isAgentApprovalComment(body: string): boolean {
  const text = String(body || "");
  return parseApprovalRequestMarker(text) !== null || isApprovalRequestAlreadySatisfied(text);
}

/**
 * Appends a human-readable approval note and a hidden satisfied marker.
 */
export function markApprovalRequestSatisfied(
  body: string,
  approver: string,
  extra?: {
    route?: string;
    workflow?: string;
    issueUrl?: string;
    runUrl?: string;
  },
): string {
  const action = extra?.workflow
    ? `\`${extra.route || "follow-up"}\` via \`${extra.workflow}\``
    : `\`${extra?.route || "follow-up"}\``;
  const trackingParts: string[] = [];
  if (extra?.issueUrl) {
    const issueNum = extra.issueUrl.match(/#?(\d+)$/)?.[1];
    trackingParts.push(issueNum ? `#${issueNum}` : extra.issueUrl);
  }
  if (extra?.runUrl) {
    trackingParts.push(`[approval run](${extra.runUrl})`);
  }
  const tracking = trackingParts.length > 0 ? trackingParts.join(", ") : "\u2014";

  const table = [
    "| Approved by | Action | Tracking |",
    "|---|---|---|",
    `| @${approver} | ${action} | ${tracking} |`,
  ].join("\n");

  return `${String(body || "").trim()}\n\n${table}\n\n<!-- sepo-agent-approved -->\n`;
}

/**
 * Matches explicit approval commands understood by the portal.
 */
export function isApprovalCommand(body: string, mention = DEFAULT_MENTION): boolean {
  return parseApprovalCommand(body, mention) !== null;
}

/**
 * Parses an approval command and extracts the referenced request ID.
 */
export function parseApprovalCommand(
  body: string,
  mention = DEFAULT_MENTION,
): ApprovalCommand | null {
  const commandRe = buildApprovalCommandRegex(mention);
  if (!commandRe) return null;
  const match = stripNonLiveMentions(String(body || "")).match(commandRe);
  if (!match) return null;
  return { requestId: match[1].toLowerCase() };
}

/**
 * Finds a specific unresolved approval request comment by request ID.
 */
export function findPendingRequestById(
  comments: Array<{
    id?: string | number;
    body?: string;
    created_at?: string;
  }>,
  requestId: string,
): PendingApproval | null {
  for (const comment of comments) {
    const request = parseApprovalRequestMarker(comment.body || "");
    if (!request) continue;
    if (String(request.request_id || "").toLowerCase() !== requestId.toLowerCase()) {
      continue;
    }
    if (isApprovalRequestAlreadySatisfied(comment.body || "")) continue;
    return {
      comment: {
        id: comment.id ?? "",
        body: comment.body || "",
        created_at: comment.created_at || "",
      },
      request,
    };
  }

  return null;
}

/**
 * Reports whether approving this request requires creating a new tracking
 * issue first. Implementation-like requests from non-issue surfaces should do that.
 */
export function shouldCreateIssueFromApprovalRequest(
  request: Record<string, unknown>,
): boolean {
  return (
    (request?.route === "implement" || request?.route === "create-action") &&
    request?.target_kind !== "issue" &&
    String(request?.issue_title || "").trim() !== ""
  );
}
