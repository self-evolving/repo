import { buildThreadKey } from "../envelope.js";
import { setOutput } from "../output.js";
import {
  buildSessionBundleArtifactName,
  createSessionBundle,
  hasValidThreadTargetNumber,
  parseSessionBundleMode,
  shouldUseSessionBundles,
} from "../session-bundle.js";
import { parseSessionPolicy } from "../session-policy.js";

const repoSlug = process.env.GITHUB_REPOSITORY || "";
const route = process.env.ROUTE || "";
const targetKind = process.env.TARGET_KIND || "";
const targetNumber = Number(process.env.TARGET_NUMBER || "0");
const lane = process.env.LANE || "default";
const agent = process.env.ACPX_AGENT || "";
const acpxRecordId = process.env.ACPX_RECORD_ID || "";
const acpxSessionId = process.env.ACPX_SESSION_ID || "";
const runId = process.env.GITHUB_RUN_ID || "run";
const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
const homeDir = process.env.HOME || "";
const runnerTemp = process.env.RUNNER_TEMP || undefined;
const policy = parseSessionPolicy(process.env.SESSION_POLICY);
const bundleMode = parseSessionBundleMode(process.env.SESSION_BUNDLE_MODE);

setOutput("bundle_created", "false");
setOutput("bundle_file", "");
setOutput("artifact_name", "");
setOutput("file_count", "0");
setOutput("total_size_bytes", "0");

if (!policy) {
  console.error("Missing or invalid SESSION_POLICY");
  process.exitCode = 2;
} else if (!shouldUseSessionBundles(bundleMode, policy)) {
  process.exit(0);
} else if (
  !repoSlug ||
  !route ||
  !targetKind ||
  !hasValidThreadTargetNumber(targetKind, targetNumber) ||
  !agent
) {
  console.error("Missing repo identity inputs for session backup");
  process.exitCode = 2;
} else if (!acpxRecordId || !acpxSessionId) {
  console.log("No acpx session identity was emitted; skipping session bundle backup.");
} else {
  const threadKey = buildThreadKey({
    repo_slug: repoSlug,
    route,
    target_kind: targetKind,
    target_number: targetNumber,
    lane,
  });
  const bundle = createSessionBundle({
    agent,
    threadKey,
    repoSlug,
    cwd,
    acpxRecordId,
    acpxSessionId,
    homeDir,
    runnerTemp,
  });

  if (!bundle) {
    console.log("No session files discovered for backup.");
  } else {
    setOutput("bundle_created", "true");
    setOutput("bundle_file", bundle.bundlePath);
    setOutput("artifact_name", buildSessionBundleArtifactName(threadKey, runId));
    setOutput("file_count", String(bundle.fileCount));
    setOutput("total_size_bytes", String(bundle.totalSizeBytes));
  }
}
