// CLI: best-effort assign a handled issue or PR to the configured agent handle.
// Usage: node .agent/dist/cli/assign-agent.js
// Env: AGENT_HANDLE, TARGET_KIND, TARGET_NUMBER, GITHUB_REPOSITORY
// Non-fatal: exits 0 even if the handle is not assignable or assignment fails.

import {
  assignAgentHandleToTarget,
  deriveAssigneeLogin,
  isAgentAssigneeTargetKind,
  normalizeAgentHandle,
  validateAssigneeLogin,
} from "../agent-assignee.js";

const agentHandle = normalizeAgentHandle(process.env.AGENT_HANDLE);
const targetKind = process.env.TARGET_KIND || "";
const targetNumberRaw = process.env.TARGET_NUMBER || "";
const repo = process.env.GITHUB_REPOSITORY || "";
const targetNumber = Number.parseInt(targetNumberRaw, 10);

if (!isAgentAssigneeTargetKind(targetKind)) {
  console.log(`Target kind ${targetKind || "(empty)"} is not assignable; skipping assignment.`);
} else if (!Number.isInteger(targetNumber) || targetNumber <= 0) {
  console.log(`Target number ${targetNumberRaw || "(empty)"} is not valid; skipping assignment.`);
} else if (!repo.trim()) {
  console.warn("GITHUB_REPOSITORY is required to assign the agent; skipping assignment.");
} else {
  const login = deriveAssigneeLogin(agentHandle);
  const validationWarning = validateAssigneeLogin(login);
  if (validationWarning) {
    console.warn(`Skipping assignment: ${validationWarning}.`);
  } else {
    try {
      const message = assignAgentHandleToTarget({
        agentHandle,
        repo,
        targetKind,
        targetNumber,
      });
      if (message.startsWith("Skipping assignment:")) {
        console.warn(message);
      } else {
        console.log(message);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Could not assign ${targetKind} #${targetNumber} to @${login}: ${msg}`);
    }
  }
}
