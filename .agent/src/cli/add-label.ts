// CLI: add the fixed agent status label to a handled issue or PR.
// Usage: node .agent/dist/cli/add-label.js
// Env: AGENT_STATUS_LABEL_ENABLED, TARGET_KIND, TARGET_NUMBER, GITHUB_REPOSITORY
// Non-fatal: exits 0 even if label creation or application fails.

import { addIssueLabel, addPrLabel, ensureLabel } from "../github.js";

const STATUS_LABEL = "agent";
const STATUS_LABEL_COLOR = "0e8a16";
const STATUS_LABEL_DESCRIPTION = "Handled by the agent";

const enabled = (process.env.AGENT_STATUS_LABEL_ENABLED || "").trim() === "true";
const targetKind = process.env.TARGET_KIND || "";
const targetNumberRaw = process.env.TARGET_NUMBER || "";
const repo = process.env.GITHUB_REPOSITORY || undefined;
const targetNumber = Number.parseInt(targetNumberRaw, 10);

if (!enabled) {
  console.log("AGENT_STATUS_LABEL_ENABLED is not true; skipping status label.");
} else if (targetKind !== "issue" && targetKind !== "pull_request") {
  console.log(`Target kind ${targetKind || "(empty)"} is not labelable; skipping status label.`);
} else if (!Number.isInteger(targetNumber) || targetNumber <= 0) {
  console.log(`Target number ${targetNumberRaw || "(empty)"} is not valid; skipping status label.`);
} else {
  try {
    ensureLabel({
      name: STATUS_LABEL,
      color: STATUS_LABEL_COLOR,
      description: STATUS_LABEL_DESCRIPTION,
      repo,
    });

    if (targetKind === "issue") {
      addIssueLabel(targetNumber, STATUS_LABEL, repo);
    } else {
      addPrLabel(targetNumber, STATUS_LABEL, repo);
    }

    console.log(`Added ${STATUS_LABEL} label to ${targetKind} #${targetNumber}.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not add ${STATUS_LABEL} label to ${targetKind} #${targetNumber}: ${msg}`);
  }
}
