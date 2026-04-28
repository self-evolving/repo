import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { buildThreadKey } from "../envelope.js";
import { configureBotIdentity } from "../git.js";
import { setOutput } from "../output.js";
import {
  findSessionBundleArchive,
  hasValidThreadTargetNumber,
  parseSessionBundleMode,
  restoreSessionBundle,
  shouldUseSessionBundles,
} from "../session-bundle.js";
import { parseSessionPolicy } from "../session-policy.js";
import {
  type PushOptions,
  type ThreadState,
  getThreadState,
  markThreadBundleRestore,
} from "../thread-state.js";

function buildThreadStateOptions(): PushOptions {
  const opts: PushOptions = { repo: process.env.GITHUB_REPOSITORY || "" };
  const token = process.env.INPUT_GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (token) opts.token = token;
  return opts;
}

function setDefaultOutputs(): void {
  setOutput("restore_status", "not_applicable");
  setOutput("restore_error", "");
  setOutput("artifact_name", "");
  setOutput("artifact_run_id", "");
  setOutput("fork_restore_status", "not_attempted");
  setOutput("fork_restore_error", "");
  setOutput("fork_from_thread_key", "");
  setOutput("fork_acpx_session_id", "");
  setOutput("fork_artifact_name", "");
  setOutput("fork_artifact_run_id", "");
}

function setForkOutputs(args: {
  status: string;
  error?: string;
  threadKey?: string;
  acpxSessionId?: string;
  artifactName?: string;
  artifactRunId?: string;
}): void {
  setOutput("fork_restore_status", args.status);
  setOutput("fork_restore_error", args.error || "");
  setOutput("fork_from_thread_key", args.threadKey || "");
  setOutput("fork_acpx_session_id", args.acpxSessionId || "");
  setOutput("fork_artifact_name", args.artifactName || "");
  setOutput("fork_artifact_run_id", args.artifactRunId || "");
}

function restoreArtifactBundle(args: {
  repoSlug: string;
  repoRoot: string;
  runnerTemp: string;
  homeDir: string;
  artifactName: string;
  artifactRunId: string;
}): void {
  const downloadDir = mkdtempSync(join(args.runnerTemp, "session-bundle-download-"));
  try {
    execFileSync(
      "gh",
      [
        "run",
        "download",
        args.artifactRunId,
        "--repo",
        args.repoSlug,
        "-n",
        args.artifactName,
        "-D",
        downloadDir,
      ],
      {
        cwd: args.repoRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const bundlePath = findSessionBundleArchive(downloadDir);
    if (!bundlePath) {
      throw new Error(`Artifact ${args.artifactName} did not contain a .tgz bundle`);
    }

    restoreSessionBundle(bundlePath, args.homeDir);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

type DestinationRestoreStatus = "restored" | "not_available" | "failed";

function tryRestoreDestination(args: {
  threadKey: string;
  state: ThreadState | null;
  repoSlug: string;
  repoRoot: string;
  runnerTemp: string;
  homeDir: string;
  threadStateOpts: PushOptions;
}): DestinationRestoreStatus {
  const artifactName = args.state?.session_bundle_artifact_name || "";
  const artifactRunId = args.state?.session_bundle_run_id || "";

  if (!artifactName || !artifactRunId) {
    markThreadBundleRestore(
      args.threadKey,
      args.repoRoot,
      { bundle_restore_status: "not_available", last_bundle_restore_error: "" },
      args.threadStateOpts,
    );
    setOutput("restore_status", "not_available");
    return "not_available";
  }

  try {
    restoreArtifactBundle({
      repoSlug: args.repoSlug,
      repoRoot: args.repoRoot,
      runnerTemp: args.runnerTemp,
      homeDir: args.homeDir,
      artifactName,
      artifactRunId,
    });
    markThreadBundleRestore(
      args.threadKey,
      args.repoRoot,
      { bundle_restore_status: "restored", last_bundle_restore_error: "" },
      args.threadStateOpts,
    );
    setOutput("restore_status", "restored");
    setOutput("artifact_name", artifactName);
    setOutput("artifact_run_id", artifactRunId);
    return "restored";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    markThreadBundleRestore(
      args.threadKey,
      args.repoRoot,
      { bundle_restore_status: "failed", last_bundle_restore_error: msg },
      args.threadStateOpts,
    );
    setOutput("restore_status", "failed");
    setOutput("restore_error", msg);
    setOutput("artifact_name", artifactName);
    setOutput("artifact_run_id", artifactRunId);
    console.warn(`Session bundle restore failed: ${msg}`);
    return "failed";
  }
}

function tryRestoreForkSource(args: {
  sourceThreadKey: string;
  destinationThreadKey: string;
  repoSlug: string;
  repoRoot: string;
  runnerTemp: string;
  homeDir: string;
  threadStateOpts: PushOptions;
}): void {
  const sourceThreadKey = String(args.sourceThreadKey || "").trim();
  if (!sourceThreadKey || sourceThreadKey === args.destinationThreadKey) {
    return;
  }

  let state: ThreadState | null = null;
  try {
    state = getThreadState(sourceThreadKey, args.repoRoot, args.threadStateOpts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setForkOutputs({ status: "failed", error: msg, threadKey: sourceThreadKey });
    console.warn(`Session fork source lookup failed: ${msg}`);
    return;
  }

  if (!state) {
    setForkOutputs({ status: "not_available", threadKey: sourceThreadKey });
    return;
  }

  const acpxSessionId = state.acpxSessionId || "";
  if (!acpxSessionId) {
    setForkOutputs({ status: "no_session_identity", threadKey: sourceThreadKey });
    return;
  }

  const artifactName = state.session_bundle_artifact_name || "";
  const artifactRunId = state.session_bundle_run_id || "";
  if (!artifactName || !artifactRunId) {
    setForkOutputs({
      status: "not_available",
      threadKey: sourceThreadKey,
      acpxSessionId,
    });
    return;
  }

  try {
    restoreArtifactBundle({
      repoSlug: args.repoSlug,
      repoRoot: args.repoRoot,
      runnerTemp: args.runnerTemp,
      homeDir: args.homeDir,
      artifactName,
      artifactRunId,
    });
    setOutput("restore_status", "restored_from_fork");
    setOutput("restore_error", "");
    setOutput("artifact_name", artifactName);
    setOutput("artifact_run_id", artifactRunId);
    setForkOutputs({
      status: "restored",
      threadKey: sourceThreadKey,
      acpxSessionId,
      artifactName,
      artifactRunId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setOutput("restore_status", "failed");
    setOutput("restore_error", msg);
    setForkOutputs({
      status: "failed",
      error: msg,
      threadKey: sourceThreadKey,
      acpxSessionId,
      artifactName,
      artifactRunId,
    });
    console.warn(`Session fork source restore failed: ${msg}`);
  }
}

const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const repoSlug = process.env.GITHUB_REPOSITORY || "";
const route = process.env.ROUTE || "";
const targetKind = process.env.TARGET_KIND || "";
const targetNumber = Number(process.env.TARGET_NUMBER || "0");
const lane = process.env.LANE || "default";
const homeDir = process.env.HOME || "";
const runnerTemp = process.env.RUNNER_TEMP || tmpdir();
const policy = parseSessionPolicy(process.env.SESSION_POLICY);
const bundleMode = parseSessionBundleMode(process.env.SESSION_BUNDLE_MODE);
const forkFromThreadKey = String(process.env.SESSION_FORK_FROM_THREAD_KEY || "").trim();

setDefaultOutputs();

if (!policy) {
  console.error("Missing or invalid SESSION_POLICY");
  process.exitCode = 2;
} else if (
  !repoSlug ||
  !route ||
  !targetKind ||
  !hasValidThreadTargetNumber(targetKind, targetNumber)
) {
  console.error("Missing repo or thread identity inputs for session restore");
  process.exitCode = 2;
} else if (!shouldUseSessionBundles(bundleMode, policy)) {
  setOutput("restore_status", "not_applicable");
  setForkOutputs({ status: "not_applicable" });
} else {
  try {
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
    const destinationRestoreStatus = tryRestoreDestination({
      threadKey,
      state,
      repoSlug,
      repoRoot,
      runnerTemp,
      homeDir,
      threadStateOpts,
    });

    if (destinationRestoreStatus !== "restored" && !state?.acpxSessionId) {
      tryRestoreForkSource({
        sourceThreadKey: forkFromThreadKey,
        destinationThreadKey: threadKey,
        repoSlug,
        repoRoot,
        runnerTemp,
        homeDir,
        threadStateOpts,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setOutput("restore_status", "failed");
    setOutput("restore_error", msg);
    console.warn(`Session bundle restore setup failed: ${msg}`);
  }
}
