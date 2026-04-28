// Mention parsing helpers. These functions are intentionally detached from
// any specific GitHub entity so mention-based workflows can reuse the same
// boundary-aware parsing and markdown stripping rules.

/**
 * Escapes user-provided mention text before building a regex around it.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes quoted and code-only content so mentions inside them do not
 * trigger the workflow.
 */
export function stripNonLiveMentions(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .filter((line) => !line.match(/^\s*>/))
    .join("\n");
}

/**
 * Builds the boundary-aware mention matcher used for the final trigger check.
 */
export function buildMentionRegex(mention: string): RegExp {
  return new RegExp(
    `(^|[\\s(])${escapeRegex(mention)}(?=[\\s.,;:!?)\\]}]|$)`,
    "m",
  );
}

/**
 * Checks whether the markdown contains a live mention after stripping
 * quoted and code-only content.
 */
export function hasLiveMention(markdown: string, mention: string): boolean {
  return buildMentionRegex(mention).test(stripNonLiveMentions(markdown));
}
