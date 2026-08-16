import { configureBotIdentity } from "../git.js";
import { setOutput } from "../output.js";
import { hasValidThreadTargetNumber } from "../session-bundle.js";
import { persistSessionRunState } from "../session-state-persistence.js";
import { parseSessionPolicy, tracksThreadState } from "../session-policy.js";
import type {
  ThreadBundleRestoreStatus,
  ThreadResumeStatus,
} from "../thread-state.js";

const RESUME_STATUSES = new Set<ThreadResumeStatus>([
  "not_attempted",
  "resumed",
  "fallback_fresh",
  "failed",
]);
const BUNDLE_RESTORE_STATUSES = new Set<ThreadBundleRestoreStatus>([
  "not_attempted",
  "not_available",
  "restored",
  "restored_from_fork",
  "failed",
]);

function parseResumeStatus(value: string): ThreadResumeStatus | null {
  const normalized = value || "not_attempted";
  return RESUME_STATUSES.has(normalized as ThreadResumeStatus)
    ? (normalized as ThreadResumeStatus)
    : null;
}

function parseBundleRestoreStatus(value: string): ThreadBundleRestoreStatus | null {
  const normalized = !value || value === "not_applicable" ? "not_attempted" : value;
  return BUNDLE_RESTORE_STATUSES.has(normalized as ThreadBundleRestoreStatus)
    ? (normalized as ThreadBundleRestoreStatus)
    : null;
}

function currentRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  return repo && runId ? `${server}/${repo}/actions/runs/${runId}` : "";
}

const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const repoSlug = process.env.GITHUB_REPOSITORY || "";
const route = process.env.ROUTE || "";
const targetKind = process.env.TARGET_KIND || "";
const targetNumber = Number(process.env.TARGET_NUMBER || "0");
const lane = process.env.LANE || "default";
const policy = parseSessionPolicy(process.env.SESSION_POLICY);
const exitCodeRaw = process.env.AGENT_EXIT_CODE || "";
const exitCode = Number(exitCodeRaw);
const expectedThreadKey = process.env.THREAD_KEY || "";
const resumeStatus = parseResumeStatus(process.env.RESUME_STATUS || "");
const bundleRestoreStatus = parseBundleRestoreStatus(
  process.env.SESSION_BUNDLE_RESTORE_STATUS || "",
);

setOutput("persisted", "false");

if (!policy) {
  console.error("Missing or invalid SESSION_POLICY");
  process.exitCode = 2;
} else if (!tracksThreadState(policy)) {
  console.log("Session policy does not track thread state; skipping persistence.");
} else if (
  !repoSlug ||
  !route ||
  !targetKind ||
  !expectedThreadKey ||
  !hasValidThreadTargetNumber(targetKind, targetNumber) ||
  !/^\d+$/.test(exitCodeRaw) ||
  !Number.isSafeInteger(exitCode) ||
  !resumeStatus ||
  !bundleRestoreStatus
) {
  console.error("Missing or invalid session-state inputs");
  process.exitCode = 2;
} else {
  const token = process.env.INPUT_GITHUB_TOKEN || process.env.GH_TOKEN || "";
  configureBotIdentity(repoRoot);
  const state = persistSessionRunState({
    repoRoot,
    repoSlug,
    route,
    targetKind,
    targetNumber,
    lane,
    expectedThreadKey,
    exitCode,
    acpxRecordId: process.env.ACPX_RECORD_ID || "",
    acpxSessionId: process.env.ACPX_SESSION_ID || "",
    resumeStatus,
    lastResumeError: process.env.LAST_RESUME_ERROR || "",
    resumedFromSessionId: process.env.RESUMED_FROM_SESSION_ID || "",
    bundleRestoreStatus,
    lastBundleRestoreError: process.env.SESSION_BUNDLE_RESTORE_ERROR || "",
    forkedFromThreadKey: process.env.SESSION_FORK_FROM_THREAD_KEY || "",
    forkedFromAcpxSessionId: process.env.SESSION_FORK_ACPX_SESSION_ID || "",
    lastRunUrl: currentRunUrl(),
    pushOptions: {
      repo: repoSlug,
      ...(token ? { token } : {}),
    },
  });
  setOutput("persisted", "true");
  setOutput("thread_key", state.thread_key);
  console.log(
    `Persisted thread state ${state.thread_key} at attempt ${state.attempt_count}.`,
  );
}
