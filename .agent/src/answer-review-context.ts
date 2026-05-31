export interface AnswerReviewContextInput {
  repoSlug: string;
  targetNumber: string;
  sourceKind: string;
  commentId: string;
  commentUrl: string;
}

export function buildAnswerReviewContext(input: AnswerReviewContextInput): string {
  const sourceKind = input.sourceKind.trim();
  if (sourceKind !== "pull_request_review") return "";

  const repoSlug = input.repoSlug.trim();
  const targetNumber = input.targetNumber.trim();
  const commentId = input.commentId.trim();
  const commentUrl = input.commentUrl.trim();

  return [
    "Review-triggered answer context:",
    `- Request source kind: \`${sourceKind}\``,
    `- Request review ID: \`${commentId}\``,
    `- Request review URL: \`${commentUrl}\``,
    "",
    "Review-specific exception:",
    "- This is the narrow exception to the normal no-GitHub-write rule: you may use `gh` to inspect the triggering review and related inline comments, then post targeted inline replies when that is what the user asked for.",
    "- Before posting an inline reply, inspect the target thread and skip replies that duplicate an existing Sepo-authored inline reply from an earlier run.",
    "- If you post any inline replies, still return a non-empty final answer body so the workflow has a normal response to post; a short summary is enough.",
    "- You may instead return only the normal answer response, or both inline replies and a summary, depending on the request.",
    "- For pull request review lookups, use this pattern as needed:",
    "  ```bash",
    `  gh api repos/${repoSlug}/pulls/${targetNumber}/reviews/${commentId}`,
    `  gh api repos/${repoSlug}/pulls/${targetNumber}/reviews/${commentId}/comments`,
    `  gh api --method POST repos/${repoSlug}/pulls/${targetNumber}/comments -f body='<reply>' -F in_reply_to=<comment_id>`,
    "  ```",
    "",
  ].join("\n");
}
