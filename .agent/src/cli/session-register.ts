import { buildThreadKey } from "../envelope.js";
import { configureBotIdentity } from "../git.js";
import { setOutput } from "../output.js";
import {
  hasValidThreadTargetNumber,
  parseSessionBundleMode,
  shouldUseSessionBundles,
} from "../session-bundle.js";
import { parseSessionPolicy } from "../session-policy.js";
import {
  type PushOptions,
  getThreadState,
  markThreadBundleStored,
} from "../thread-state.js";

function buildThreadStateOptions(): PushOptions {
  const opts: PushOptions = { repo: process.env.GITHUB_REPOSITORY || "" };
  const token = process.env.INPUT_GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (token) opts.token = token;
  return opts;
}

const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const repoSlug = process.env.GITHUB_REPOSITORY || "";
const route = process.env.ROUTE || "";
const targetKind = process.env.TARGET_KIND || "";
const targetNumber = Number(process.env.TARGET_NUMBER || "0");
const lane = process.env.LANE || "default";
const artifactId = process.env.SESSION_BUNDLE_ARTIFACT_ID || "";
const artifactName = process.env.SESSION_BUNDLE_ARTIFACT_NAME || "";
const runId = process.env.GITHUB_RUN_ID || "";
const sessionRecordId = process.env.SESSION_RECORD_ID || "";
const sessionId = process.env.SESSION_ID || "";
const policy = parseSessionPolicy(process.env.SESSION_POLICY);
const bundleMode = parseSessionBundleMode(process.env.SESSION_BUNDLE_MODE);

setOutput("registered", "false");

if (!policy) {
  console.error("Missing or invalid SESSION_POLICY");
  process.exitCode = 2;
} else if (!shouldUseSessionBundles(bundleMode, policy)) {
  process.exit(0);
} else if (
  !artifactId ||
  !artifactName ||
  !repoSlug ||
  !route ||
  !targetKind ||
  !hasValidThreadTargetNumber(targetKind, targetNumber)
) {
  console.log("No session bundle artifact metadata to register.");
} else {
  const threadKey = buildThreadKey({
    repo_slug: repoSlug,
    route,
    target_kind: targetKind,
    target_number: targetNumber,
    lane,
  });
  const threadStateOpts = buildThreadStateOptions();
  configureBotIdentity(repoRoot);

  const state = getThreadState(threadKey, repoRoot, threadStateOpts);
  if (!state) {
    console.log("No thread state found while registering session bundle; skipping.");
  } else if (
    (sessionId && state.acpxSessionId !== sessionId) ||
    (sessionRecordId && state.acpxRecordId !== sessionRecordId)
  ) {
    console.log(
      "Thread state session identity no longer matches the uploaded bundle; skipping registration.",
    );
  } else {
    markThreadBundleStored(
      threadKey,
      repoRoot,
      {
        session_bundle_backend: "github-artifact",
        session_bundle_artifact_id: artifactId,
        session_bundle_artifact_name: artifactName,
        session_bundle_run_id: runId,
      },
      threadStateOpts,
    );
    setOutput("registered", "true");
  }
}
