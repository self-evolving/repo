export const FIX_PR_STATUS_MARKER = "<!-- sepo-agent-fix-pr-status -->";

const FIX_PR_STATUS_PATTERNS = [
  /\*\*Sepo pushed fixes for this PR\.\*\*/,
  /\*\*Sepo did not produce code changes for this PR\.\*\*/,
  /\*\*Sepo could not update this PR automatically\.\*\*/,
  /\*\*Sepo could not complete the PR fix run\.\*\*/,
  /\*\*Sepo made changes, but lightweight verification failed\.\*\*[\s\S]*Inspect the workflow logs before retrying the PR fix run\./,
];

export function buildFixPrStatusMarker(): string {
  return FIX_PR_STATUS_MARKER;
}

export function isFixPrStatusBody(body: string): boolean {
  const value = String(body || "");
  return value.includes(FIX_PR_STATUS_MARKER) ||
    FIX_PR_STATUS_PATTERNS.some((pattern) => pattern.test(value));
}
