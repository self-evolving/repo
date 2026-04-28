// CLI: fetch PR metadata and checkout the PR head branch.
// Usage: node .agent/dist/cli/checkout-pr.js
// Env: PR_NUMBER, GH_TOKEN, GITHUB_REPOSITORY
// Outputs: head_ref, head_sha, cross_repo, pr_state

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setOutput } from "../output.js";
import { fetchPrMeta } from "../github.js";

const prNumber = Number(process.env.PR_NUMBER || "0");
const token = process.env.GH_TOKEN || "";
const repo = process.env.GITHUB_REPOSITORY || "";
const cwd = process.env.GITHUB_WORKSPACE || process.cwd();

if (!prNumber) {
  console.error("Missing PR_NUMBER");
  process.exitCode = 2;
} else {
  const meta = fetchPrMeta(prNumber);
  let headSha = meta.headOid;

  if (!meta.isCrossRepository && meta.state === "OPEN") {
    const remoteUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
    execFileSync("git", ["fetch", remoteUrl, meta.headRef], { cwd, stdio: "pipe" });
    // setup-agent-runtime builds .agent/dist before fix-pr checks out the PR
    // branch. If that branch accidentally tracks generated dist files, Git
    // refuses to switch because the freshly built untracked files would be
    // overwritten. Remove only this known generated directory before checkout.
    rmSync(join(cwd, ".agent", "dist"), { recursive: true, force: true });
    execFileSync("git", ["checkout", "-B", meta.headRef, "FETCH_HEAD"], { cwd, stdio: "pipe" });
    headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe" })
      .toString("utf8")
      .trim();
  }

  setOutput("head_ref", meta.headRef);
  setOutput("head_sha", headSha);
  setOutput("cross_repo", String(meta.isCrossRepository));
  setOutput("pr_state", meta.state);
}
