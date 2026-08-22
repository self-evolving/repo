import { normalizeRunMarkerId } from "./run-marker.js";

export const SEPO_FINAL_RESPONSE_MARKER_PREFIX = "<!-- sepo-final-response:run-";
const SEPO_FINAL_RESPONSE_MARKER_RE = /<!--\s*sepo-final-response:run-[^>\s]+\s*-->/;
const SEPO_FINAL_RESPONSE_MARKER_GLOBAL_RE = /<!--\s*sepo-final-response:run-[^>\s]+\s*-->/g;

export function finalResponseMarker(runId: string): string {
  return `${SEPO_FINAL_RESPONSE_MARKER_PREFIX}${normalizeRunMarkerId(runId)} -->`;
}

export function hasFinalResponseMarker(body: string): boolean {
  return SEPO_FINAL_RESPONSE_MARKER_RE.test(String(body || ""));
}

export function appendFinalResponseMarker(body: string, runId: string): string {
  const normalizedBody = String(body || "")
    .replace(SEPO_FINAL_RESPONSE_MARKER_GLOBAL_RE, "")
    .trim();
  return [normalizedBody, finalResponseMarker(runId)].filter(Boolean).join("\n\n");
}
