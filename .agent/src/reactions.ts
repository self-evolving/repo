// Emoji reactions via GitHub GraphQL and REST APIs (gh CLI).
//
// Replaces the Octokit-based reactions.cjs with gh api calls,
// consistent with the self-serve pattern in the local runtime's GitHub helpers.

import { execFileSync } from "node:child_process";
import { isKnownAuthorAssociation } from "./access-policy.js";
import { ghApi, ghApiOk } from "./github.js";

const MAX_BUFFER = 10 * 1024 * 1024;
const TRUSTED_CANCEL_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface CommentReaction {
  content: string;
  user: string;
}

export interface AuthorizedCancelReaction {
  content: "THUMBS_DOWN";
  user: string;
  authorization: "REQUESTER" | "OWNER" | "MEMBER" | "COLLABORATOR";
}

/**
 * Adds a reaction to a GitHub node (issue, comment, PR, etc.).
 * @param subjectId - The GraphQL node ID of the subject.
 * @param content - The reaction content (e.g., "EYES", "THUMBS_UP").
 */
export function addReaction(subjectId: string, content: string): void {
  const query = `
    mutation($subjectId: ID!, $content: ReactionContent!) {
      addReaction(input: { subjectId: $subjectId, content: $content }) {
        reaction { content }
      }
    }
  `;
  execFileSync(
    "gh",
    [
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `subjectId=${subjectId}`,
      "-f", `content=${content}`,
    ],
    { stdio: "pipe", maxBuffer: MAX_BUFFER },
  );
}

function normalizeReactionContent(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "-1" || lower === "thumbs_down") return "THUMBS_DOWN";
  if (lower === "+1" || lower === "thumbs_up") return "THUMBS_UP";
  return raw.toUpperCase();
}

function extractLogin(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" ? login.trim() : "";
}

function normalizeActorLogin(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^app\//i, "")
    .replace(/\[bot\]$/i, "");
}

function normalizeAssociation(value: string): string {
  return String(value || "").trim().toUpperCase();
}

function isTrustedCancelAssociation(
  association: string,
): boolean {
  const normalized = normalizeAssociation(association);
  return isKnownAuthorAssociation(normalized) && TRUSTED_CANCEL_ASSOCIATIONS.has(normalized);
}

function normalizeReactionRecord(value: unknown): CommentReaction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const content = normalizeReactionContent(record.content);
  const user = extractLogin(record.user);
  if (!content || !user) return null;
  return { content, user };
}

function reactionEntriesFromPages(parsed: unknown): unknown[] {
  if (!Array.isArray(parsed)) return [];
  if (parsed.every((page) => Array.isArray(page))) {
    return parsed.flatMap((page) => page as unknown[]);
  }
  return parsed;
}

export function listCommentReactions(
  repo: string,
  commentId: string | number,
): CommentReaction[] {
  const repository = String(repo || "").trim();
  const id = String(commentId || "").trim();
  if (!repository || !id) return [];

  const raw = ghApi([
    "--paginate",
    "--slurp",
    `repos/${repository}/issues/comments/${id}/reactions`,
  ]);
  if (!raw) return [];

  try {
    return reactionEntriesFromPages(JSON.parse(raw))
      .map(normalizeReactionRecord)
      .filter((reaction): reaction is CommentReaction => Boolean(reaction));
  } catch {
    return [];
  }
}

function escapePathPart(value: string): string {
  return encodeURIComponent(String(value || "").trim());
}

function hasOrgMembership(orgLogin: string, userLogin: string): boolean {
  const org = escapePathPart(orgLogin);
  const user = escapePathPart(userLogin);
  if (!org || !user) return false;

  const membershipState = ghApi([
    `orgs/${org}/memberships/${user}`,
    "--jq",
    ".state // empty",
  ]).toLowerCase();
  if (membershipState === "active") return true;

  return ghApiOk([`orgs/${org}/members/${user}`]);
}

function resolveTrustedCancelAssociation(
  repo: string,
  userLogin: string,
): "OWNER" | "MEMBER" | "COLLABORATOR" | null {
  const repository = String(repo || "").trim();
  const login = String(userLogin || "").trim();
  const [owner] = repository.split("/");
  if (!repository || !login || !owner) return null;

  if (normalizeActorLogin(owner) === normalizeActorLogin(login)) {
    return "OWNER";
  }

  const permission = ghApi([
    `repos/${repository}/collaborators/${escapePathPart(login)}/permission`,
    "--jq",
    ".permission // .role_name // empty",
  ]).toLowerCase();
  if (permission && permission !== "none") {
    return "COLLABORATOR";
  }

  if (hasOrgMembership(owner, login)) {
    return "MEMBER";
  }

  return null;
}

export function findAuthorizedCancelReaction(
  repo: string,
  reactions: readonly CommentReaction[],
  requesterLogin: string,
): AuthorizedCancelReaction | null {
  const requester = normalizeActorLogin(requesterLogin);
  for (const reaction of reactions) {
    if (normalizeReactionContent(reaction.content) !== "THUMBS_DOWN") continue;

    const reactor = normalizeActorLogin(reaction.user);
    if (!reactor) continue;

    if (requester && reactor === requester) {
      return {
        content: "THUMBS_DOWN",
        user: reaction.user,
        authorization: "REQUESTER",
      };
    }

    const association = resolveTrustedCancelAssociation(repo, reaction.user);
    if (association && isTrustedCancelAssociation(association)) {
      return {
        content: "THUMBS_DOWN",
        user: reaction.user,
        authorization: association,
      };
    }
  }

  return null;
}

export function hasAuthorizedCancelReaction(
  repo: string,
  reactions: readonly CommentReaction[],
  requesterLogin: string,
): boolean {
  return Boolean(findAuthorizedCancelReaction(repo, reactions, requesterLogin));
}
