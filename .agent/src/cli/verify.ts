// CLI: run post-agent verification.
// Usage: node .agent/dist/cli/verify.js
// Env: GITHUB_WORKSPACE, HEAD_CHANGED, VERIFY_BASE_SHA
// Outputs: verify_exit_code, has_changes

import { hasChanges } from "../git.js";
import { runVerification, shouldRunVerification } from "../verify.js";
import { setOutput } from "../output.js";

const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
const headChanged = process.env.HEAD_CHANGED === "true";
const verifyBaseSha = process.env.VERIFY_BASE_SHA || "";
const worktreeChanged = hasChanges(cwd);

if (!shouldRunVerification(worktreeChanged, headChanged)) {
  setOutput("verify_exit_code", "0");
  setOutput("has_changes", "false");
  process.exit(0);
}

if (headChanged && !verifyBaseSha) {
  console.error("HEAD_CHANGED=true requires VERIFY_BASE_SHA for history-aware verification.");
  setOutput("verify_exit_code", "1");
  setOutput("has_changes", String(worktreeChanged));
  process.exit(1);
}

const result = runVerification(cwd, { baseSha: verifyBaseSha });
setOutput("verify_exit_code", String(result.exitCode));
setOutput("has_changes", String(worktreeChanged));
process.exitCode = result.exitCode;
