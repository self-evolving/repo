export const REVIEW_SYNTHESIS_HEADING = "## AI Review Synthesis";
export const REVIEW_SYNTHESIS_MARKER = "<!-- sepo-agent-review-synthesis -->";

export function buildReviewSynthesisMarker(): string {
  return REVIEW_SYNTHESIS_MARKER;
}

export function isReviewSynthesisBody(body: string): boolean {
  return body.includes(REVIEW_SYNTHESIS_MARKER)
    || body.trimStart().startsWith(REVIEW_SYNTHESIS_HEADING);
}
