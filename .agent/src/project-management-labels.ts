import {
  addIssueLabel,
  addPrLabel,
  ensureLabel,
  removeIssueLabel,
  removePrLabel,
} from "./github.js";

export type ProjectItemKind = "issue" | "pull_request";

export interface ManagedLabelChange {
  kind: ProjectItemKind;
  number: number;
  add: string[];
  remove: string[];
}

export interface ManagedLabelPlan {
  label_changes: ManagedLabelChange[];
  valid: boolean;
}

interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

const LABEL_DEFINITIONS: LabelDefinition[] = [
  { name: "priority/p0", color: "b60205", description: "Project management: highest priority" },
  { name: "priority/p1", color: "d93f0b", description: "Project management: high priority" },
  { name: "priority/p2", color: "fbca04", description: "Project management: medium priority" },
  { name: "priority/p3", color: "c2e0c6", description: "Project management: low priority" },
  { name: "effort/low", color: "c2e0c6", description: "Project management: low effort" },
  { name: "effort/medium", color: "fbca04", description: "Project management: medium effort" },
  { name: "effort/high", color: "d73a4a", description: "Project management: high effort" },
];

const MANAGED_LABELS = new Set(LABEL_DEFINITIONS.map((label) => label.name));

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalizeKind(value: unknown): ProjectItemKind | null {
  if (value === "issue" || value === "pull_request") return value;
  return null;
}

function uniqueManagedLabels(labels: string[]): string[] {
  return [...new Set(labels)].filter((label) => MANAGED_LABELS.has(label));
}

export function parseManagedLabelPlan(markdown: string): ManagedLabelPlan {
  const fence = markdown.match(/```json\s*([\s\S]*?)```/i);
  if (!fence) return { label_changes: [], valid: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch {
    return { label_changes: [], valid: false };
  }

  const root = asRecord(parsed);
  if (!root || !Array.isArray(root.label_changes)) {
    return { label_changes: [], valid: false };
  }

  const label_changes: ManagedLabelChange[] = [];

  for (const rawChange of root.label_changes) {
    const change = asRecord(rawChange);
    if (!change) continue;
    const kind = normalizeKind(change.kind);
    const number = typeof change.number === "number" && Number.isInteger(change.number) && change.number > 0
      ? change.number
      : null;
    if (!kind || !number) continue;

    label_changes.push({
      kind,
      number,
      add: uniqueManagedLabels(stringArray(change.add)),
      remove: uniqueManagedLabels(stringArray(change.remove)),
    });
  }

  return { label_changes, valid: true };
}

export function ensureManagedLabels(repo: string): void {
  for (const label of LABEL_DEFINITIONS) {
    ensureLabel({ ...label, repo });
  }
}

export function applyManagedLabelChange(change: ManagedLabelChange, repo: string): void {
  for (const label of change.remove) {
    if (change.kind === "issue") removeIssueLabel(change.number, label, repo);
    else removePrLabel(change.number, label, repo);
  }

  for (const label of change.add) {
    if (change.kind === "issue") addIssueLabel(change.number, label, repo);
    else addPrLabel(change.number, label, repo);
  }
}

export function countManagedLabelOperations(changes: ManagedLabelChange[]): number {
  return changes.reduce((total, change) => total + change.add.length + change.remove.length, 0);
}
