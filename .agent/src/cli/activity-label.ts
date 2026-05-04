// CLI: add or remove the route-specific activity label for an issue or PR.
// Usage: node .agent/dist/cli/activity-label.js
// Env: ACTIVITY_LABEL_ACTION, ROUTE, TARGET_KIND, TARGET_NUMBER, GITHUB_REPOSITORY
// Non-fatal: exits 0 even if label creation, application, or removal fails.

import {
  ActivityLabelAction,
  applyActivityLabel,
  isActivityLabelTargetKind,
  resolveActivityLabel,
} from "../activity-labels.js";

function normalizeAction(value: string): ActivityLabelAction | null {
  const normalized = value.trim().toLowerCase();
  return normalized === "add" || normalized === "remove" ? normalized : null;
}

const action = normalizeAction(process.env.ACTIVITY_LABEL_ACTION || "");
const route = process.env.ROUTE || "";
const targetKind = process.env.TARGET_KIND || "";
const targetNumberRaw = process.env.TARGET_NUMBER || "";
const repo = process.env.GITHUB_REPOSITORY || undefined;
const targetNumber = Number.parseInt(targetNumberRaw, 10);
const label = resolveActivityLabel(route);

if (!action) {
  console.log(`ACTIVITY_LABEL_ACTION must be add or remove; got ${process.env.ACTIVITY_LABEL_ACTION || "(empty)"}.`);
} else if (!label) {
  console.log(`Route ${route || "(empty)"} has no activity label; skipping.`);
} else if (!isActivityLabelTargetKind(targetKind)) {
  console.log(`Target kind ${targetKind || "(empty)"} is not labelable; skipping activity label.`);
} else if (!Number.isInteger(targetNumber) || targetNumber <= 0) {
  console.log(`Target number ${targetNumberRaw || "(empty)"} is not valid; skipping activity label.`);
} else {
  try {
    console.log(applyActivityLabel({
      action,
      route,
      targetKind,
      targetNumber,
      repo,
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not ${action} ${label.name} label on ${targetKind} #${targetNumber}: ${msg}`);
  }
}
