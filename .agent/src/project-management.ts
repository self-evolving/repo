export type ProjectItemKind = "issue" | "pull_request";
export type Priority = "p0" | "p1" | "p2" | "p3";
export type Urgency = "now" | "soon" | "later";

export interface ProjectLabel {
  name: string;
}

export interface ProjectItem {
  kind: ProjectItemKind;
  number: number;
  title: string;
  body?: string | null;
  labels: ProjectLabel[];
  createdAt?: string | null;
  updatedAt?: string | null;
  comments?: number | null;
  assignees?: unknown[] | null;
  isDraft?: boolean | null;
  reviewDecision?: string | null;
}

export interface ProjectItemScore {
  item: ProjectItem;
  priority: Priority;
  urgency: Urgency;
  priorityScore: number;
  urgencyScore: number;
  reasons: string[];
}

export interface LabelChange {
  add: string[];
  remove: string[];
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  p0: "priority/p0",
  p1: "priority/p1",
  p2: "priority/p2",
  p3: "priority/p3",
};

export const URGENCY_LABELS: Record<Urgency, string> = {
  now: "urgency/now",
  soon: "urgency/soon",
  later: "urgency/later",
};

export const PROJECT_MANAGEMENT_LABELS = [
  ...Object.values(PRIORITY_LABELS),
  ...Object.values(URGENCY_LABELS),
];

const PRIORITY_WORDS = [
  "security",
  "vulnerability",
  "critical",
  "data loss",
  "broken",
  "regression",
  "blocker",
  "production",
];

const URGENCY_WORDS = [
  "urgent",
  "asap",
  "today",
  "deadline",
  "blocked",
  "blocker",
  "security",
  "vulnerability",
];

function labelNames(item: ProjectItem): string[] {
  return item.labels.map((label) => label.name.toLowerCase());
}

function textFor(item: ProjectItem): string {
  return `${item.title}\n${item.body || ""}`.toLowerCase();
}

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / 86_400_000));
}

function hasAny(value: string, words: string[]): boolean {
  return words.some((word) => value.includes(word));
}

function priorityFromScore(score: number): Priority {
  if (score >= 6) return "p0";
  if (score >= 4) return "p1";
  if (score >= 2) return "p2";
  return "p3";
}

function urgencyFromScore(score: number): Urgency {
  if (score >= 5) return "now";
  if (score >= 2) return "soon";
  return "later";
}

export function scoreProjectItem(item: ProjectItem, now = new Date()): ProjectItemScore {
  const labels = labelNames(item);
  const text = textFor(item);
  const updatedDays = daysSince(item.updatedAt, now);
  const comments = Math.max(0, Number(item.comments || 0));
  let priorityScore = 0;
  let urgencyScore = 0;
  const reasons: string[] = [];

  if (labels.some((label) => ["bug", "regression", "security"].includes(label))) {
    priorityScore += 3;
    reasons.push("impact label");
  }
  if (labels.some((label) => ["enhancement", "feature"].includes(label))) {
    priorityScore += 1;
    reasons.push("feature work");
  }
  if (hasAny(text, PRIORITY_WORDS)) {
    priorityScore += 3;
    reasons.push("high-impact wording");
  }
  if (comments >= 5) {
    priorityScore += 1;
    reasons.push("active discussion");
  }

  if (hasAny(text, URGENCY_WORDS)) {
    urgencyScore += 4;
    reasons.push("time-sensitive wording");
  }
  if (item.kind === "pull_request" && !item.isDraft) {
    if (item.reviewDecision === "REVIEW_REQUIRED" || item.reviewDecision === "CHANGES_REQUESTED") {
      urgencyScore += 3;
      reasons.push("PR needs review action");
    }
  }
  if (updatedDays !== null && updatedDays >= 14) {
    urgencyScore += 2;
    reasons.push("stale open item");
  } else if (updatedDays !== null && updatedDays <= 2 && comments > 0) {
    urgencyScore += 1;
    reasons.push("recent activity");
  }

  return {
    item,
    priority: priorityFromScore(priorityScore),
    urgency: urgencyFromScore(urgencyScore),
    priorityScore,
    urgencyScore,
    reasons,
  };
}

export function planLabelChange(score: ProjectItemScore): LabelChange {
  const current = score.item.labels.map((label) => label.name);
  const wanted = [PRIORITY_LABELS[score.priority], URGENCY_LABELS[score.urgency]];
  const managed = new Set(PROJECT_MANAGEMENT_LABELS);
  const currentSet = new Set(current);

  return {
    add: wanted.filter((label) => !currentSet.has(label)),
    remove: current.filter((label) => managed.has(label) && !wanted.includes(label)),
  };
}

export function formatProjectManagementSummary(
  scores: ProjectItemScore[],
  changes: Map<string, LabelChange>,
  opts: { dryRun: boolean; labelsApplied: boolean },
): string {
  const sorted = [...scores].sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    if (b.urgencyScore !== a.urgencyScore) return b.urgencyScore - a.urgencyScore;
    return a.item.number - b.item.number;
  });
  const counts = new Map<string, number>();
  for (const score of scores) {
    const key = `${PRIORITY_LABELS[score.priority]} / ${URGENCY_LABELS[score.urgency]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const lines = [
    "## Project Management Summary",
    "",
    `Mode: ${opts.dryRun ? "dry run" : opts.labelsApplied ? "labels applied" : "labels not applied"}`,
    `Open items scored: ${scores.length}`,
    "",
    "### Label Buckets",
    "",
  ];

  for (const [key, count] of [...counts.entries()].sort()) {
    lines.push(`- ${key}: ${count}`);
  }

  lines.push("", "### Highest Priority Items", "");
  for (const score of sorted.slice(0, 10)) {
    const key = `${score.item.kind}#${score.item.number}`;
    const change = changes.get(key);
    const changeText = change && (change.add.length > 0 || change.remove.length > 0)
      ? `; label changes: +${change.add.join(", ") || "none"} / -${change.remove.join(", ") || "none"}`
      : "";
    const reasonText = score.reasons.length > 0 ? ` (${score.reasons.join("; ")})` : "";
    lines.push(
      `- ${key}: ${score.item.title} - ${PRIORITY_LABELS[score.priority]}, ${URGENCY_LABELS[score.urgency]}${reasonText}${changeText}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
