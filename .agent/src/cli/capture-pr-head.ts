// CLI: capture the current PR head SHA for workflows that need a stable reviewed head.
// Env: GITHUB_REPOSITORY, TARGET_NUMBER
// Outputs: head_sha

import { fetchPrMeta } from "../github.js";
import { setOutput } from "../output.js";

const repo = process.env.GITHUB_REPOSITORY || "";
const targetNumber = Number(process.env.TARGET_NUMBER || process.env.PR_NUMBER || "");

if (!repo || !targetNumber) {
  throw new Error("missing pull request target");
}

const meta = fetchPrMeta(targetNumber, repo);
if (!meta.headOid) {
  throw new Error("could not resolve pull request head SHA");
}

setOutput("head_sha", meta.headOid);
