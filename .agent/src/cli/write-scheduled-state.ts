#!/usr/bin/env node
// CLI: write a ref-backed scheduled workflow state record.

import { configureBotIdentity } from "../git.js";
import { fetchJsonState, writeJsonState, type PushOptions } from "../scheduled-activity.js";
import { setOutput } from "../output.js";

function buildOptions(): PushOptions {
  const repo = process.env.GITHUB_REPOSITORY || process.env.REPO_SLUG || "";
  const token = process.env.INPUT_GITHUB_TOKEN || process.env.GH_TOKEN || "";
  return { repo, token: token || undefined };
}

const ref = process.env.SCHEDULE_STATE_REF || "";
const field = process.env.SCHEDULE_STATE_FIELD || "";
const value = process.env.SCHEDULE_STATE_VALUE || new Date().toISOString();
const repoSlug = process.env.REPO_SLUG || process.env.GITHUB_REPOSITORY || "";
const runUrl = process.env.SCHEDULE_LAST_RUN_URL || "";
const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
const options = buildOptions();

setOutput("written", "false");

if (!ref) {
  console.error("Missing SCHEDULE_STATE_REF");
  process.exitCode = 2;
} else if (!field) {
  console.error("Missing SCHEDULE_STATE_FIELD");
  process.exitCode = 2;
} else {
  configureBotIdentity(cwd);

  const now = new Date().toISOString();
  const existing = fetchJsonState(ref, cwd, options) || {};
  const next = {
    ...existing,
    schema_version: 1,
    repo_slug: repoSlug || existing.repo_slug || "",
    [field]: value,
    last_run_url: runUrl || existing.last_run_url || "",
    created_at: typeof existing.created_at === "string" ? existing.created_at : now,
    updated_at: now,
  };

  writeJsonState(ref, next, cwd, options);
  setOutput("written", "true");
  process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
}
