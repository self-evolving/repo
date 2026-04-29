#!/usr/bin/env node
// CLI: score open issues and PRs for project management labels.
// Env: GITHUB_REPOSITORY, AGENT_PROJECT_MANAGEMENT_ENABLED,
//      AGENT_PROJECT_MANAGEMENT_DRY_RUN, AGENT_PROJECT_MANAGEMENT_APPLY_LABELS,
//      AGENT_PROJECT_MANAGEMENT_POST_SUMMARY, AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY

import { appendFileSync } from "node:fs";
import { addDiscussionComment, findRepositoryDiscussionByTitle } from "../discussion.js";
import {
  addIssueLabel,
  addPrLabel,
  ensureLabel,
  gh,
  removeIssueLabel,
  removePrLabel,
} from "../github.js";
import { setOutput } from "../output.js";
import {
  formatProjectManagementSummary,
  planLabelChange,
  PROJECT_MANAGEMENT_LABELS,
  scoreProjectItem,
  type LabelChange,
  type ProjectItem,
  type ProjectItemKind,
} from "../project-management.js";

interface GhLabel {
  name?: string | null;
}

interface GhProjectItem {
  number?: number | null;
  title?: string | null;
  body?: string | null;
  labels?: GhLabel[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  comments?: number | null;
  assignees?: unknown[] | null;
  isDraft?: boolean | null;
  reviewDecision?: string | null;
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

function boolEnv(name: string, fallback = false): boolean {
  const value = (process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const [owner, repo, extra] = slug.split("/");
  if (!owner || !repo || extra) {
    throw new Error(`GITHUB_REPOSITORY must be owner/repo (got: ${slug || "missing"})`);
  }
  return { owner, repo };
}

function parseItems(kind: ProjectItemKind, raw: string): ProjectItem[] {
  const parsed = JSON.parse(raw) as GhProjectItem[];
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item) => Number.isInteger(item.number) && (item.number as number) > 0)
    .map((item) => ({
      kind,
      number: item.number as number,
      title: item.title || "",
      body: item.body || "",
      labels: (item.labels || [])
        .map((label) => ({ name: label.name || "" }))
        .filter((label) => label.name),
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      comments: item.comments || 0,
      assignees: item.assignees || [],
      isDraft: item.isDraft || false,
      reviewDecision: item.reviewDecision || null,
    }));
}

function listOpenItems(repo: string, limit: number): ProjectItem[] {
  const issueArgs = [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,body,labels,createdAt,updatedAt,comments,assignees",
  ];
  const prArgs = [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,body,labels,createdAt,updatedAt,comments,assignees,isDraft,reviewDecision",
  ];

  return [
    ...parseItems("issue", gh(issueArgs)),
    ...parseItems("pull_request", gh(prArgs)),
  ];
}

function ensureProjectLabels(repo: string): void {
  for (const label of LABEL_DEFINITIONS) {
    ensureLabel({ ...label, repo });
  }
}

function itemKey(item: ProjectItem): string {
  return `${item.kind}#${item.number}`;
}

function applyChange(item: ProjectItem, change: LabelChange, repo: string): void {
  for (const label of change.remove) {
    if (item.kind === "issue") {
      removeIssueLabel(item.number, label, repo);
    } else {
      removePrLabel(item.number, label, repo);
    }
  }

  for (const label of change.add) {
    if (item.kind === "issue") {
      addIssueLabel(item.number, label, repo);
    } else {
      addPrLabel(item.number, label, repo);
    }
  }
}

function writeStepSummary(markdown: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  try {
    appendFileSync(summaryFile, `${markdown}\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not write project management step summary: ${msg}`);
  }
}

function safeSetOutput(name: string, value: string): void {
  try {
    setOutput(name, value);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not set ${name} output: ${msg}`);
  }
}

function dailySummaryTitle(date = new Date()): string {
  const override = process.env.AGENT_PROJECT_MANAGEMENT_SUMMARY_DATE?.trim();
  if (override) return `Daily Summary — ${override}`;
  return `Daily Summary — ${date.toISOString().slice(0, 10)}`;
}

function postDailySummaryComment(repoSlug: string, summary: string): void {
  const { owner, repo } = parseRepoSlug(repoSlug);
  const category = process.env.AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY?.trim() || "General";
  const title = dailySummaryTitle();
  const discussion = findRepositoryDiscussionByTitle(owner, repo, title, category);

  if (!discussion) {
    console.warn(`Daily summary discussion '${title}' was not found in category '${category}'; skipping comment.`);
    return;
  }

  const url = addDiscussionComment(discussion.id, summary);
  console.log(`Posted project management summary to ${discussion.url || `discussion #${discussion.number}`}: ${url}`);
}

function main(): number {
  const enabled = boolEnv("AGENT_PROJECT_MANAGEMENT_ENABLED");
  const repo = process.env.GITHUB_REPOSITORY || "";
  const limit = numberEnv("AGENT_PROJECT_MANAGEMENT_LIMIT", 100);
  const dryRun = boolEnv("AGENT_PROJECT_MANAGEMENT_DRY_RUN", true);
  const applyLabels = boolEnv("AGENT_PROJECT_MANAGEMENT_APPLY_LABELS");
  const postSummary = boolEnv("AGENT_PROJECT_MANAGEMENT_POST_SUMMARY");

  if (!enabled) {
    const message = "Project management is disabled; set AGENT_PROJECT_MANAGEMENT_ENABLED=true to run it.";
    console.log(message);
    safeSetOutput("skipped", "true");
    safeSetOutput("summary", message);
    return 0;
  }

  if (!repo) {
    console.error("GITHUB_REPOSITORY is required.");
    return 1;
  }

  const items = listOpenItems(repo, limit);
  const scores = items.map((item) => scoreProjectItem(item));
  const changes = new Map<string, LabelChange>();

  for (const score of scores) {
    changes.set(itemKey(score.item), planLabelChange(score));
  }

  const shouldApplyLabels = applyLabels && !dryRun;
  if (shouldApplyLabels) {
    ensureProjectLabels(repo);
    for (const score of scores) {
      const change = changes.get(itemKey(score.item));
      if (change) applyChange(score.item, change, repo);
    }
  } else {
    console.log(
      dryRun
        ? "Dry run enabled; no project management labels were changed."
        : "AGENT_PROJECT_MANAGEMENT_APPLY_LABELS is not true; no project management labels were changed.",
    );
    console.log(`Managed labels: ${PROJECT_MANAGEMENT_LABELS.join(", ")}`);
  }

  const summary = formatProjectManagementSummary(scores, changes, {
    dryRun,
    labelsApplied: shouldApplyLabels,
  });
  console.log(summary);
  writeStepSummary(summary);
  safeSetOutput("skipped", "false");
  safeSetOutput("summary", summary);

  if (postSummary) {
    postDailySummaryComment(repo, summary);
  }

  return 0;
}

process.exitCode = main();
