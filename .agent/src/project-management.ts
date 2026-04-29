export type ProjectItemKind = "issue" | "pull_request";
export type Priority = "p0" | "p1" | "p2" | "p3";
export type Effort = "low" | "medium" | "high";

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
  effort: Effort;
  priorityScore: number;
  actionScore: number;
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

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "effort/low",
  medium: "effort/medium",
  high: "effort/high",
};

export const PROJECT_MANAGEMENT_LABELS = [
  ...Object.values(PRIORITY_LABELS),
  ...Object.values(EFFORT_LABELS),
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

const LOW_EFFORT_WORDS = [
  "docs",
  "documentation",
  "typo",
  "copy",
  "small",
  "minor",
  "simple",
];

const HIGH_EFFORT_WORDS = [
  "architecture",
  "migration",
  "refactor",
  "integration",
  "workflow",
  "security",
  "database",
  "breaking",
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

function effortFrom(item: ProjectItem, text: string, comments: number): Effort {
  if (hasAny(text, HIGH_EFFORT_WORDS) || comments >= 8) return "high";
  if (hasAny(text, LOW_EFFORT_WORDS) && comments < 5) return "low";
  if (item.kind === "pull_request" && !item.isDraft && item.reviewDecision === "REVIEW_REQUIRED") return "low";
  return "medium";
}

export function scoreProjectItem(item: ProjectItem, now = new Date()): ProjectItemScore {
  const labels = labelNames(item);
  const text = textFor(item);
  const updatedDays = daysSince(item.updatedAt, now);
  const comments = Math.max(0, Number(item.comments || 0));
  let priorityScore = 0;
  let actionScore = 0;
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
    actionScore += 4;
    reasons.push("time-sensitive wording");
  }
  if (item.kind === "pull_request" && !item.isDraft) {
    if (item.reviewDecision === "REVIEW_REQUIRED" || item.reviewDecision === "CHANGES_REQUESTED") {
      actionScore += 3;
      reasons.push("PR needs review action");
    }
  }
  if (updatedDays !== null && updatedDays >= 14) {
    actionScore += 2;
    reasons.push("stale open item");
  } else if (updatedDays !== null && updatedDays <= 2 && comments > 0) {
    actionScore += 1;
    reasons.push("recent activity");
  }

  return {
    item,
    priority: priorityFromScore(priorityScore),
    effort: effortFrom(item, text, comments),
    priorityScore,
    actionScore,
    reasons,
  };
}

export function planLabelChange(score: ProjectItemScore): LabelChange {
  const current = score.item.labels.map((label) => label.name);
  const wanted = [PRIORITY_LABELS[score.priority], EFFORT_LABELS[score.effort]];
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
    if (b.actionScore !== a.actionScore) return b.actionScore - a.actionScore;
    return a.item.number - b.item.number;
  });
  const counts = new Map<string, number>();
  for (const score of scores) {
    const key = `${PRIORITY_LABELS[score.priority]} / ${EFFORT_LABELS[score.effort]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const lines = [
    "## Project Management Summary",
    "",
    `Mode: ${opts.dryRun ? "dry run" : opts.labelsApplied ? "labels applied" : "labels not applied"}`,
    `Open items scored: ${scores.length}`,
    "",
    "### Triage Label Buckets",
    "",
  ];

  for (const [key, count] of [...counts.entries()].sort()) {
    lines.push(`- ${key}: ${count}`);
  }

  lines.push("", "### Top Triage Queue", "");
  for (const score of sorted.slice(0, 10)) {
    const key = `${score.item.kind}#${score.item.number}`;
    const change = changes.get(key);
    const changeText = change && (change.add.length > 0 || change.remove.length > 0)
      ? `; label changes: +${change.add.join(", ") || "none"} / -${change.remove.join(", ") || "none"}`
      : "";
    const reasonText = score.reasons.length > 0 ? ` (${score.reasons.join("; ")})` : "";
    lines.push(
      `- ${key}: ${score.item.title} - ${PRIORITY_LABELS[score.priority]}, ${EFFORT_LABELS[score.effort]}, action score ${score.actionScore}${reasonText}${changeText}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
