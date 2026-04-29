// Emoji reactions via GitHub GraphQL API (gh CLI).
//
// Replaces the Octokit-based reactions.cjs with gh api calls,
// consistent with the self-serve pattern in the local runtime's GitHub helpers.

import { execFileSync } from "node:child_process";

const MAX_BUFFER = 10 * 1024 * 1024;

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
