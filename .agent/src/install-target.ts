const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?";
const REPO = "[A-Za-z0-9._-]+";
const SLUG_PATTERN = `${OWNER}/${REPO}`;
const GITHUB_URL_RE = new RegExp(
  String.raw`https?://github\.com/(${OWNER})/(${REPO})(?:\.git)?(?:[/?#][^\s<>"')\]}]*)?(?=$|[\s.,;:!?)\]}])`,
  "gi",
);
const SLUG_RE = new RegExp(
  String.raw`(?:^|[^\w.-])(${SLUG_PATTERN})(?=$|[^\w.-])`,
  "g",
);

interface Span {
  start: number;
  end: number;
}

export interface InstallTargetResolution {
  status: "clear" | "missing" | "ambiguous";
  targetRepo: string;
  candidates: string[];
  message: string;
}

function normalizeRepo(owner: string, repo: string): string {
  const normalizedRepo = repo
    .replace(/[.,;:!?)\]}]+$/g, "")
    .replace(/\.git$/i, "");
  return `${owner}/${normalizedRepo}`;
}

function uniqueCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function spanContains(spans: Span[], start: number, end: number): boolean {
  return spans.some((span) => start >= span.start && end <= span.end);
}

export function resolveInstallTargetFromText(text: string): InstallTargetResolution {
  const body = String(text || "");
  const candidates: string[] = [];
  const urlSpans: Span[] = [];

  for (const match of body.matchAll(GITHUB_URL_RE)) {
    const start = match.index ?? 0;
    urlSpans.push({ start, end: start + match[0].length });
    candidates.push(normalizeRepo(match[1] || "", match[2] || ""));
  }

  for (const match of body.matchAll(SLUG_RE)) {
    const slug = String(match[1] || "");
    const slugStart = (match.index ?? 0) + String(match[0] || "").indexOf(slug);
    const slugEnd = slugStart + slug.length;
    if (spanContains(urlSpans, slugStart, slugEnd)) {
      continue;
    }
    const [owner, repo] = String(match[1] || "").split("/");
    candidates.push(normalizeRepo(owner || "", repo || ""));
  }

  const unique = uniqueCandidates(candidates.filter(Boolean));
  if (unique.length === 0) {
    return {
      status: "missing",
      targetRepo: "",
      candidates: [],
      message: "No target repository was found. Ask the requester for a GitHub repository URL or owner/repo slug.",
    };
  }
  if (unique.length > 1) {
    return {
      status: "ambiguous",
      targetRepo: "",
      candidates: unique,
      message: `Multiple possible target repositories were found: ${unique.join(", ")}. Ask the requester to choose one.`,
    };
  }

  return {
    status: "clear",
    targetRepo: unique[0] || "",
    candidates: unique,
    message: `Resolved install target: ${unique[0] || ""}.`,
  };
}
