#!/usr/bin/env node
// CLI: update the ref-backed memory sync state with new cursors.

import { configureBotIdentity } from "../../git.js";
import {
  createMemorySyncState,
  fetchMemorySyncState,
  updateMemorySyncState,
  writeMemorySyncState,
  type PushOptions,
} from "../../memory-sync-state.js";
import { setOutput } from "../../output.js";

function buildOptions(): PushOptions {
  const repo = process.env.GITHUB_REPOSITORY || process.env.REPO_SLUG || "";
  const token = process.env.INPUT_GITHUB_TOKEN || process.env.GH_TOKEN || "";
  return { repo, token: token || undefined };
}

const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
const repoSlug = process.env.REPO_SLUG || process.env.GITHUB_REPOSITORY || "";
const options = buildOptions();
const lastSyncAt = process.env.SYNC_LAST_SYNC_AT || "";
const lastActivityAt = process.env.SYNC_LAST_ACTIVITY_AT || "";
const lastRunUrl = process.env.SYNC_LAST_RUN_URL || "";

setOutput("written", "false");

if (!repoSlug) {
  console.error("Missing REPO_SLUG or GITHUB_REPOSITORY");
  process.exitCode = 2;
} else if (!lastSyncAt) {
  console.error("Missing SYNC_LAST_SYNC_AT");
  process.exitCode = 2;
} else {
  configureBotIdentity(cwd);

  const existing = fetchMemorySyncState(cwd, options) || createMemorySyncState(repoSlug);
  const next = updateMemorySyncState(existing, {
    last_sync_at: lastSyncAt,
    last_activity_at: lastActivityAt || existing.last_activity_at || lastSyncAt,
    last_run_url: lastRunUrl,
    cursors: {
      issues: process.env.SYNC_ISSUE_CURSOR || existing.cursors.issues,
      pulls: process.env.SYNC_PULL_CURSOR || existing.cursors.pulls,
      discussions: process.env.SYNC_DISCUSSION_CURSOR || existing.cursors.discussions,
      commits: process.env.SYNC_COMMIT_CURSOR || existing.cursors.commits,
    },
  });

  writeMemorySyncState(next, cwd, options);
  setOutput("written", "true");
  process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
}
