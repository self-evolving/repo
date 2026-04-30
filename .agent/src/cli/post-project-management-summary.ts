#!/usr/bin/env node
// CLI: publish the project-manager agent's final summary.
// Env: BODY or BODY_FILE, GITHUB_STEP_SUMMARY, GITHUB_REPOSITORY,
//      AGENT_PROJECT_MANAGEMENT_POST_SUMMARY,
//      AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY,
//      AGENT_PROJECT_MANAGEMENT_SUMMARY_DATE (optional)

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { addDiscussionComment, findRepositoryDiscussionByTitle } from "../discussion.js";
import { setOutput } from "../output.js";

function boolEnv(name: string, fallback = false): boolean {
  const value = (process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() || "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const [owner, repo, extra] = slug.split("/");
  if (!owner || !repo || extra) {
    throw new Error(`GITHUB_REPOSITORY must be owner/repo (got: ${slug || "missing"})`);
  }
  return { owner, repo };
}

function dailySummaryTitle(date = new Date()): string {
  const override = process.env.AGENT_PROJECT_MANAGEMENT_SUMMARY_DATE?.trim();
  if (override) return `Daily Summary — ${override}`;
  return `Daily Summary — ${date.toISOString().slice(0, 10)}`;
}

function writeStepSummary(markdown: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  appendFileSync(summaryFile, `${markdown}\n`);
}

function readSummary(): string {
  const body = process.env.BODY?.trim();
  if (body) return body;

  const bodyFile = requiredEnv("BODY_FILE");
  if (!existsSync(bodyFile)) {
    throw new Error(`Project management summary file was not produced: ${bodyFile}`);
  }

  return readFileSync(bodyFile, "utf8").trim();
}

function publishDiscussionComment(summary: string): string | null {
  const { owner, repo } = parseRepoSlug(requiredEnv("GITHUB_REPOSITORY"));
  const category = process.env.AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY?.trim() || "General";
  const title = dailySummaryTitle();
  const discussion = findRepositoryDiscussionByTitle(owner, repo, title, category);

  if (!discussion) {
    console.warn(`Daily summary discussion '${title}' was not found in category '${category}'; skipping comment.`);
    return null;
  }

  const url = addDiscussionComment(discussion.id, summary);
  console.log(`Posted project management summary to ${discussion.url || `discussion #${discussion.number}`}: ${url}`);
  return url;
}

function main(): number {
  try {
    const summary = readSummary();
    if (!summary) {
      throw new Error("Project management summary is empty");
    }

    writeStepSummary(summary);
    setOutput("summary", summary);

    if (!boolEnv("AGENT_PROJECT_MANAGEMENT_POST_SUMMARY")) {
      setOutput("summary_posted", "false");
      setOutput("summary_url", "");
      console.log("Project management summary posting is disabled; wrote Actions step summary only.");
      return 0;
    }

    const url = publishDiscussionComment(summary);
    setOutput("summary_posted", url ? "true" : "false");
    setOutput("summary_url", url || "");
    return 0;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exitCode = main();
