// Emoji reactions via GitHub GraphQL and REST APIs (gh CLI).
//
// Replaces the Octokit-based reactions.cjs with gh api calls,
// consistent with the self-serve pattern in the local runtime's GitHub helpers.

import { execFileSync } from "node:child_process";
import {
  normalizeGithubActorLogin,
  resolveGithubActorAssociation,
} from "./actor-association.js";
import { ghApi } from "./github.js";

const MAX_BUFFER = 10 * 1024 * 1024;
type TrustedCancelAssociation = "OWNER" | "MEMBER" | "COLLABORATOR";
const TRUSTED_CANCEL_ASSOCIATIONS = new Set<TrustedCancelAssociation>([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

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

function isTrustedCancelAssociation(
  association: string,
): association is TrustedCancelAssociation {
  return TRUSTED_CANCEL_ASSOCIATIONS.has(
    String(association || "").trim().toUpperCase() as TrustedCancelAssociation,
  );
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

function resolveTrustedCancelAssociation(
  repo: string,
  userLogin: string,
): TrustedCancelAssociation | null {
  const association = resolveGithubActorAssociation({
    repo,
    actorLogin: userLogin,
    lookupOrder: "repository-first",
  });
  return isTrustedCancelAssociation(association) ? association : null;
}

export function findAuthorizedCancelReaction(
  repo: string,
  reactions: readonly CommentReaction[],
  requesterLogin: string,
): AuthorizedCancelReaction | null {
  const requester = normalizeGithubActorLogin(requesterLogin);
  for (const reaction of reactions) {
    if (normalizeReactionContent(reaction.content) !== "THUMBS_DOWN") continue;

    const reactor = normalizeGithubActorLogin(reaction.user);
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
