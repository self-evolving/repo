// CLI: detect whether the checked-out branch HEAD changed during a run.
// Usage: node .agent/dist/cli/detect-head-change.js
// Env: ORIGINAL_HEAD_SHA, GITHUB_WORKSPACE
// Outputs: head_changed, current_head

import { currentHead, hasHeadChanged } from "../git.js";
import { setOutput } from "../output.js";

const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
const originalHead = process.env.ORIGINAL_HEAD_SHA || "";
const current = currentHead(cwd);

if (!originalHead) {
  console.warn("ORIGINAL_HEAD_SHA was not set; treating branch head as unchanged.");
}

setOutput("current_head", current);
setOutput("head_changed", String(hasHeadChanged(originalHead, cwd)));
