export interface ImplementationBaseHintInput {
  requestText: string;
  requestSourceKind?: string;
  triggerKind?: string;
  targetKind: string;
  targetNumber: string;
  baseBranch?: string;
  basePr?: string;
}

export interface ImplementationBaseHint {
  baseBranch: string;
  basePr: string;
  source: "provided" | "stacked_request" | "none";
}

const STACKED_PR_PATTERNS = [
  /\b(?:stack|stacked|stacking)\s+(?:pr|pull request|branch)\b/i,
  /\b(?:stack|stacked|stacking)\s+(?:on|onto|against)\s+(?:this|it|the\s+(?:pr|pull request|branch))\b/i,
  /\bon\s+top\s+of\s+(?:this|the)\s+(?:pr|pull request|branch)\b/i,
  /\bbas(?:e|ed|ing)\s+(?:it|this|the\s+work|the\s+implementation|the\s+pr|the\s+pull\s+request)?\s*(?:on|off)\s+(?:this|the)\s+(?:pr|pull request|branch)\b/i,
  /\bfollow[-\s]?up\s+(?:pr|pull request|branch)\b/i,
  /\bas\s+a\s+follow[-\s]?up\s+(?:pr|pull request|branch)\b/i,
  /\bfollow[-\s]?up\s+(?:to|on|against)\s+(?:this|the)\s+(?:pr|pull request|branch)\b/i,
];

const COMMENT_SOURCE_KINDS = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "discussion_comment",
]);

const EXPLICIT_IMPLEMENT_COMMAND = /(?:^|[\s(])\/implement(?=$|[\s.,;:!?)\]}])/i;

function parsePositiveTargetNumber(value: string): number | null {
  const trimmed = String(value || "").trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function requestImpliesStackedPr(requestText: string): boolean {
  const text = String(requestText || "");
  return STACKED_PR_PATTERNS.some((pattern) => pattern.test(text));
}

function canDeriveFromRequestText(input: ImplementationBaseHintInput): boolean {
  const triggerKind = String(input.triggerKind || "").trim().toLowerCase();
  if (triggerKind === "label") {
    return false;
  }

  const requestSourceKind = String(input.requestSourceKind || "").trim().toLowerCase();
  return (
    COMMENT_SOURCE_KINDS.has(requestSourceKind) ||
    EXPLICIT_IMPLEMENT_COMMAND.test(String(input.requestText || ""))
  );
}

export function resolveImplementationBaseHint(
  input: ImplementationBaseHintInput,
): ImplementationBaseHint {
  const baseBranch = String(input.baseBranch || "").trim();
  const basePr = String(input.basePr || "").trim();
  if (baseBranch || basePr) {
    return { baseBranch, basePr, source: "provided" };
  }

  if (String(input.targetKind || "").trim().toLowerCase() !== "pull_request") {
    return { baseBranch: "", basePr: "", source: "none" };
  }

  const targetNumber = parsePositiveTargetNumber(input.targetNumber);
  if (
    targetNumber === null ||
    !canDeriveFromRequestText(input) ||
    !requestImpliesStackedPr(input.requestText)
  ) {
    return { baseBranch: "", basePr: "", source: "none" };
  }

  return { baseBranch: "", basePr: String(targetNumber), source: "stacked_request" };
}
