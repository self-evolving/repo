// CLI: stage, commit, and push changes.
// Usage: node .agent/dist/cli/commit.js
// Env: COMMIT_CWD or GITHUB_WORKSPACE, COMMIT_MESSAGE, BRANCH, GH_TOKEN, GITHUB_REPOSITORY
//      PUSH_REF (optional — push to HEAD:<ref> instead of branch)
//      PUSH_LEASE_OID (optional — use --force-with-lease=<ref>:<oid>)
//      SET_UPSTREAM (optional — set upstream tracking)
// Outputs: committed (true/false), branch

import { configureBotIdentity, commitAndPush } from "../git.js";
import { setOutput } from "../output.js";

const cwd = process.env.COMMIT_CWD || process.env.GITHUB_WORKSPACE || process.cwd();
const message = process.env.COMMIT_MESSAGE || "chore: agent changes";
const branch = process.env.BRANCH || "";
const token = process.env.GH_TOKEN || "";
const repo = process.env.GITHUB_REPOSITORY || "";
const pushRef = process.env.PUSH_REF || undefined;
const pushLeaseOid = process.env.PUSH_LEASE_OID || undefined;
const setUpstream = process.env.SET_UPSTREAM === "true";

configureBotIdentity(cwd);

const result = commitAndPush({
  message,
  branch,
  token,
  repo,
  cwd,
  pushRef,
  pushLeaseOid,
  setUpstream,
});

setOutput("committed", String(result.committed));
setOutput("branch", result.branch);

if (!result.committed) {
  console.log("No changes to commit.");
}
