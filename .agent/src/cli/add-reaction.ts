// CLI: add a reaction to a GitHub node.
// Usage: node .agent/dist/cli/add-reaction.js
// Env: REACTION_SUBJECT_ID, REACTION_CONTENT (e.g., "EYES", "THUMBS_UP")
// Non-fatal: exits 0 even if the reaction fails.

import { addReaction } from "../reactions.js";

const subjectId = process.env.REACTION_SUBJECT_ID || "";
const content = process.env.REACTION_CONTENT || "";

if (!subjectId) {
  console.log("No REACTION_SUBJECT_ID; skipping reaction.");
} else if (!content) {
  console.log("No REACTION_CONTENT; skipping reaction.");
} else {
  try {
    addReaction(subjectId, content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not add ${content} reaction: ${msg}`);
  }
}
