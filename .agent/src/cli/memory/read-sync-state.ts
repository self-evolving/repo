#!/usr/bin/env node
// CLI: read the ref-backed memory sync state and emit cursors as step outputs.

import { fetchMemorySyncState, type PushOptions } from "../../memory-sync-state.js";
import { setOutput } from "../../output.js";

function buildOptions(): PushOptions {
  const repo = process.env.GITHUB_REPOSITORY || process.env.REPO_SLUG || "";
  const token = process.env.INPUT_GITHUB_TOKEN || process.env.GH_TOKEN || "";
  return { repo, token: token || undefined };
}

const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
const state = fetchMemorySyncState(cwd, buildOptions());

setOutput("found", state ? "true" : "false");
setOutput("last_sync_at", state?.last_sync_at || "");
setOutput("issue_cursor", state?.cursors.issues || "");
setOutput("pull_cursor", state?.cursors.pulls || "");
setOutput("discussion_cursor", state?.cursors.discussions || "");
setOutput("commit_cursor", state?.cursors.commits || "");
setOutput("last_run_url", state?.last_run_url || "");

process.stdout.write(state ? `${JSON.stringify(state, null, 2)}\n` : "{}\n");
