export const REVIEW_SYNTHESIS_HEADING = "## AI Review Synthesis";
export const REVIEW_SYNTHESIS_MARKER = "<!-- sepo-agent-review-synthesis -->";
export const REVIEW_SYNTHESIS_HEAD_MARKER_PREFIX = "sepo-agent-review-synthesis-head";

export function buildReviewSynthesisMarker(): string {
  return REVIEW_SYNTHESIS_MARKER;
}

export function buildReviewSynthesisHeadMarker(headSha: string): string {
  const normalized = String(headSha || "").trim();
  return normalized ? `<!-- ${REVIEW_SYNTHESIS_HEAD_MARKER_PREFIX}: ${normalized} -->` : "";
}

export function extractReviewSynthesisHeadSha(body: string): string {
  const match = String(body || "").match(
    /<!--\s*sepo-agent-review-synthesis-head:\s*([0-9a-f]{6,64})\s*-->/i,
  );
  return match ? match[1].trim() : "";
}

export function isReviewSynthesisBody(body: string): boolean {
  return body.includes(REVIEW_SYNTHESIS_MARKER)
    || body.trimStart().startsWith(REVIEW_SYNTHESIS_HEADING);
}
