import {
  addIssueLabel,
  addPrLabel,
  ensureLabel,
  removeIssueLabel,
  removePrLabel,
} from "./github.js";

export type ActivityLabelAction = "add" | "remove";

export interface ActivityLabel {
  route: string;
  name: string;
  color: string;
  description: string;
}

export const ACTIVITY_LABELS: ActivityLabel[] = [
  {
    route: "implement",
    name: "agent-running/implement",
    color: "0969da",
    description: "Sepo is implementing this issue",
  },
  {
    route: "create-action",
    name: "agent-running/create-action",
    color: "8250df",
    description: "Sepo is creating an agent action",
  },
  {
    route: "review",
    name: "agent-running/review",
    color: "bf3989",
    description: "Sepo is reviewing this pull request",
  },
  {
    route: "fix-pr",
    name: "agent-running/fix-pr",
    color: "d1242f",
    description: "Sepo is fixing this pull request",
  },
  {
    route: "orchestrate",
    name: "agent-running/orchestrate",
    color: "fb8c00",
    description: "Sepo orchestration is running",
  },
];

function normalizeRoute(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

export function resolveActivityLabel(route: string): ActivityLabel | null {
  const normalized = normalizeRoute(route);
  return ACTIVITY_LABELS.find((label) => label.route === normalized) || null;
}

export function isActivityLabelTargetKind(value: string): value is "issue" | "pull_request" {
  return value === "issue" || value === "pull_request";
}

export function applyActivityLabel(input: {
  action: ActivityLabelAction;
  route: string;
  targetKind: "issue" | "pull_request";
  targetNumber: number;
  repo?: string;
}): string {
  const label = resolveActivityLabel(input.route);
  if (!label) {
    return `Route ${input.route || "(empty)"} has no activity label; skipping.`;
  }

  if (input.action === "add") {
    ensureLabel({
      name: label.name,
      color: label.color,
      description: label.description,
      repo: input.repo,
    });
    if (input.targetKind === "issue") {
      addIssueLabel(input.targetNumber, label.name, input.repo);
    } else {
      addPrLabel(input.targetNumber, label.name, input.repo);
    }
    return `Added ${label.name} label to ${input.targetKind} #${input.targetNumber}.`;
  }

  if (input.targetKind === "issue") {
    removeIssueLabel(input.targetNumber, label.name, input.repo);
  } else {
    removePrLabel(input.targetNumber, label.name, input.repo);
  }
  return `Removed ${label.name} label from ${input.targetKind} #${input.targetNumber}.`;
}
