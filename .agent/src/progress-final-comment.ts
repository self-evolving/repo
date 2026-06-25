import {
  fetchIssueCommentBody,
  updateIssueComment,
} from "./github.js";
import { appendRunDisplayFooter } from "./response.js";

export interface ProgressFinalCommentOptions {
  repo: string;
  commentId: string;
  mode: string;
  finalBody: string;
  footer?: string;
  log?: (message: string) => void;
}

const PROGRESS_MARKER_RE = /<!--\s*sepo-progress:run-[^>]+-->/;
const ACTIVITY_DETAILS_RE = /<details>\s*<summary>Activity<\/summary>\s*([\s\S]*?)<\/details>/m;

export function mergeFinalBodyWithProgress(finalBody: string, progressBody: string): string {
  const normalizedFinalBody = String(finalBody || "").trim();
  const marker = progressBody.match(PROGRESS_MARKER_RE)?.[0] || "";
  const activity = extractProgressActivity(progressBody);
  const lines = [normalizedFinalBody];

  if (activity) {
    lines.push(
      "",
      "---",
      "",
      "<details>",
      "<summary>Sepo activity</summary>",
      "",
      activity,
      "</details>",
    );
  }

  if (marker) {
    lines.push("", marker);
  }

  return lines.filter((line, index) => index === 0 || line !== undefined).join("\n");
}

export function tryMergeProgressFinalComment(options: ProgressFinalCommentOptions): boolean {
  const mode = String(options.mode || "").trim().toLowerCase();
  const repo = options.repo.trim();
  const commentId = options.commentId.trim();
  if (mode !== "merge" || !repo || !commentId) {
    return false;
  }

  try {
    const progressBody = fetchIssueCommentBody(repo, commentId);
    const mergedBody = mergeFinalBodyWithProgress(options.finalBody, progressBody);
    updateIssueComment(repo, commentId, appendRunDisplayFooter(mergedBody, options.footer));
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const log = options.log ?? console.warn;
    log(`Failed to merge final response into progress comment ${commentId}: ${message}`);
    return false;
  }
}

function extractProgressActivity(progressBody: string): string {
  const body = String(progressBody || "").replace(PROGRESS_MARKER_RE, "").trim();
  if (!body) return "";

  const titleMatch = body.match(/^###\s+(.+)$/m);
  const detailsMatch = body.match(ACTIVITY_DETAILS_RE);
  const detailsStart = detailsMatch?.index ?? body.length;
  const beforeDetails = body
    .slice(0, detailsStart)
    .replace(/^###\s+.+\n?/, "")
    .trim();
  const details = detailsMatch?.[1]?.trim() || "";
  const parts = [];

  if (titleMatch?.[1]) {
    parts.push(`**${titleMatch[1].trim()}**`);
  }
  if (beforeDetails) {
    parts.push(beforeDetails);
  }
  if (details) {
    parts.push("Activity", details);
  } else {
    const fallback = body.replace(/^###\s+.+\n?/, "").trim();
    if (fallback && fallback !== beforeDetails) {
      parts.push(fallback);
    }
  }

  return parts.join("\n\n");
}
