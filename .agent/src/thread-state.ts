// Thread state: durable cross-run state for agent sessions.
//
// Pure data operations (types, create, update, normalize) at the top.
// Git-refs I/O at the bottom — stores state as JSON blobs in orphan
// commits under refs/agent-state/<thread-key>. O(1) reads, atomic
// writes via --force-with-lease, built-in audit trail, no comment
// pollution, works for all target kinds (issues, PRs, discussions).
//
// Ref layout:
//   refs/agent-state/<key>  →  commit  →  tree  →  state.json (blob)

import { git, buildAuthUrl } from "./git.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const THREAD_STATE_SCHEMA_VERSION = 3;

export type ThreadStatus = "pending" | "running" | "completed" | "failed";
export type ThreadResumeStatus = "not_attempted" | "resumed" | "fallback_fresh" | "failed";
export type ThreadBundleRestoreStatus =
  | "not_attempted"
  | "not_available"
  | "restored"
  | "restored_from_fork"
  | "failed";

export interface ThreadState {
  schema_version: number;
  thread_key: string;
  acpxRecordId: string;
  acpxSessionId: string;
  agentSessionId: string;
  branch: string;
  status: ThreadStatus;
  resume_status: ThreadResumeStatus;
  last_resume_error: string;
  resumed_from_session_id: string;
  session_bundle_backend: string;
  session_bundle_artifact_id: string;
  session_bundle_artifact_name: string;
  // Workflow run that uploaded the artifact; needed for `gh run download`.
  session_bundle_run_id: string;
  bundle_restore_status: ThreadBundleRestoreStatus;
  last_bundle_restore_error: string;
  forked_from_thread_key: string;
  forked_from_acpx_session_id: string;
  last_run_url: string;
  last_comment_url: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

interface ThreadStateRecord extends Record<string, unknown> {
  schema_version?: unknown;
  thread_key?: unknown;
  acpxRecordId?: unknown;
  acpxSessionId?: unknown;
  agentSessionId?: unknown;
  branch?: unknown;
  status?: unknown;
  resume_status?: unknown;
  last_resume_error?: unknown;
  resumed_from_session_id?: unknown;
  session_bundle_backend?: unknown;
  session_bundle_artifact_id?: unknown;
  session_bundle_artifact_name?: unknown;
  session_bundle_run_id?: unknown;
  bundle_restore_status?: unknown;
  last_bundle_restore_error?: unknown;
  forked_from_thread_key?: unknown;
  forked_from_acpx_session_id?: unknown;
  last_run_url?: unknown;
  last_comment_url?: unknown;
  attempt_count?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

const VALID_THREAD_STATUSES = new Set<ThreadStatus>([
  "pending",
  "running",
  "completed",
  "failed",
]);
const VALID_RESUME_STATUSES = new Set<ThreadResumeStatus>([
  "not_attempted",
  "resumed",
  "fallback_fresh",
  "failed",
]);
const VALID_BUNDLE_RESTORE_STATUSES = new Set<ThreadBundleRestoreStatus>([
  "not_attempted",
  "not_available",
  "restored",
  "restored_from_fork",
  "failed",
]);

// ---------------------------------------------------------------------------
// Pure data operations
// ---------------------------------------------------------------------------

export function createThreadState(threadKey: string): ThreadState {
  const now = new Date().toISOString();
  return {
    schema_version: THREAD_STATE_SCHEMA_VERSION,
    thread_key: threadKey,
    acpxRecordId: "",
    acpxSessionId: "",
    agentSessionId: "",
    branch: "",
    status: "pending",
    resume_status: "not_attempted",
    last_resume_error: "",
    resumed_from_session_id: "",
    session_bundle_backend: "",
    session_bundle_artifact_id: "",
    session_bundle_artifact_name: "",
    session_bundle_run_id: "",
    bundle_restore_status: "not_attempted",
    last_bundle_restore_error: "",
    forked_from_thread_key: "",
    forked_from_acpx_session_id: "",
    last_run_url: "",
    last_comment_url: "",
    attempt_count: 0,
    created_at: now,
    updated_at: now,
  };
}

export function updateThreadState(
  state: ThreadState,
  updates: Partial<ThreadState>,
): ThreadState {
  return {
    ...state,
    ...updates,
    schema_version: state.schema_version,
    thread_key: state.thread_key,
    created_at: state.created_at,
    updated_at: new Date().toISOString(),
  };
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toIsoOrNow(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function toPositiveIntOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Normalizes persisted thread state, including legacy pre-schema-v3 data.
 * Legacy `status: "resume_failed"` is upgraded to:
 * - `status: "failed"`
 * - `resume_status: "failed"`
 */
export function normalizeThreadState(
  raw: unknown,
  fallbackThreadKey?: string,
): ThreadState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as ThreadStateRecord;
  const now = new Date().toISOString();
  const threadKey =
    (typeof record.thread_key === "string" && record.thread_key) ||
    fallbackThreadKey ||
    "";
  if (!threadKey) {
    return null;
  }

  const rawStatus = typeof record.status === "string" ? record.status : "pending";
  const status: ThreadStatus = VALID_THREAD_STATUSES.has(rawStatus as ThreadStatus)
    ? (rawStatus as ThreadStatus)
    : rawStatus === "resume_failed"
      ? "failed"
      : "pending";

  const resumeStatus: ThreadResumeStatus = VALID_RESUME_STATUSES.has(record.resume_status as ThreadResumeStatus)
    ? (record.resume_status as ThreadResumeStatus)
    : rawStatus === "resume_failed"
      ? "failed"
      : "not_attempted";

  const bundleRestoreStatus: ThreadBundleRestoreStatus = VALID_BUNDLE_RESTORE_STATUSES.has(
    record.bundle_restore_status as ThreadBundleRestoreStatus,
  )
    ? (record.bundle_restore_status as ThreadBundleRestoreStatus)
    : "not_attempted";

  return {
    schema_version: THREAD_STATE_SCHEMA_VERSION,
    thread_key: threadKey,
    acpxRecordId: toStringOrEmpty(record.acpxRecordId),
    acpxSessionId: toStringOrEmpty(record.acpxSessionId),
    agentSessionId: toStringOrEmpty(record.agentSessionId),
    branch: toStringOrEmpty(record.branch),
    status,
    resume_status: resumeStatus,
    last_resume_error: toStringOrEmpty(record.last_resume_error),
    resumed_from_session_id: toStringOrEmpty(record.resumed_from_session_id),
    session_bundle_backend: toStringOrEmpty(record.session_bundle_backend),
    session_bundle_artifact_id: toStringOrEmpty(record.session_bundle_artifact_id),
    session_bundle_artifact_name: toStringOrEmpty(record.session_bundle_artifact_name),
    session_bundle_run_id: toStringOrEmpty(record.session_bundle_run_id),
    bundle_restore_status: bundleRestoreStatus,
    last_bundle_restore_error: toStringOrEmpty(record.last_bundle_restore_error),
    forked_from_thread_key: toStringOrEmpty(record.forked_from_thread_key),
    forked_from_acpx_session_id: toStringOrEmpty(record.forked_from_acpx_session_id),
    last_run_url: toStringOrEmpty(record.last_run_url),
    last_comment_url: toStringOrEmpty(record.last_comment_url),
    attempt_count: toPositiveIntOrZero(record.attempt_count),
    created_at: toIsoOrNow(record.created_at, now),
    updated_at: toIsoOrNow(record.updated_at, now),
  };
}

// ---------------------------------------------------------------------------
// Ref naming
// ---------------------------------------------------------------------------

const REF_PREFIX = "refs/agent-state";
const STATE_FILENAME = "state.json";

/**
 * Converts a thread_key into a safe, injective ref path component.
 * thread_key format: owner/repo:target_kind:target_number:route:lane
 *
 * Uses percent-encoding for `/` and `%` to guarantee the mapping is
 * reversible — distinct thread keys always produce distinct ref names.
 * `:` is replaced with `--` (safe since `--` cannot appear in any
 * individual field value).
 */
export function threadKeyToRefName(threadKey: string): string {
  return threadKey
    .replace(/%/g, "%25")
    .replace(/\//g, "%2F")
    .replace(/:/g, "--")
    .replace(/[^a-zA-Z0-9._%-]/g, "_");
}

export function refPathForThreadKey(threadKey: string): string {
  return `${REF_PREFIX}/${threadKeyToRefName(threadKey)}`;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const REF_NOT_FOUND_PATTERN = /couldn't find remote ref|no matching remote head/i;

export function fetchThreadState(
  threadKey: string,
  cwd: string,
  opts?: PushOptions,
): ThreadState | null {
  const ref = refPathForThreadKey(threadKey);
  const origin = opts?.remote ?? "origin";
  const fetchTarget = resolveRemoteTarget(origin, opts);

  try {
    git(["fetch", "--no-tags", fetchTarget, `+${ref}:${ref}`], cwd);
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString("utf8") ?? String(err);
    if (REF_NOT_FOUND_PATTERN.test(stderr)) {
      return null;
    }
    throw err;
  }

  try {
    const json = git(["cat-file", "blob", `${ref}:${STATE_FILENAME}`], cwd);
    return normalizeThreadState(JSON.parse(json), threadKey);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface PushOptions {
  remote?: string;
  token?: string;
  repo?: string;
}

function resolveRemoteTarget(remote: string, opts?: PushOptions): string {
  if (opts?.token && opts?.repo) {
    return buildAuthUrl(opts.token, opts.repo);
  }
  return remote;
}

export function writeThreadState(
  threadKey: string,
  state: ThreadState,
  cwd: string,
  opts?: PushOptions,
): void {
  const ref = refPathForThreadKey(threadKey);
  const origin = opts?.remote ?? "origin";
  const json = JSON.stringify(state, null, 2) + "\n";

  const blobSha = git(["hash-object", "-w", "--stdin"], cwd, json);
  const treeInput = `100644 blob ${blobSha}\t${STATE_FILENAME}\n`;
  const treeSha = git(["mktree"], cwd, treeInput);

  let parentArg: string[];
  let expectedOid: string | null = null;
  try {
    const parentSha = git(["rev-parse", "--verify", ref], cwd);
    parentArg = ["-p", parentSha];
    expectedOid = parentSha;
  } catch {
    parentArg = [];
  }

  const commitMessage = `agent-state: ${state.status}/${state.resume_status} (attempt ${state.attempt_count})`;
  const commitSha = git(["commit-tree", treeSha, ...parentArg, "-m", commitMessage], cwd);

  git(["update-ref", ref, commitSha], cwd);

  const pushTarget = resolveRemoteTarget(origin, opts);
  const leaseArg = expectedOid
    ? `--force-with-lease=${ref}:${expectedOid}`
    : "--force";
  git(["push", leaseArg, pushTarget, `${ref}:${ref}`], cwd);
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export function getThreadState(
  threadKey: string,
  cwd: string,
  opts?: PushOptions,
): ThreadState | null {
  return fetchThreadState(threadKey, cwd, opts);
}

export interface ThreadStateRunningUpdates {
  last_run_url?: string;
  branch?: string;
  resume_status?: ThreadResumeStatus;
  last_resume_error?: string;
  resumed_from_session_id?: string;
  forked_from_thread_key?: string;
  forked_from_acpx_session_id?: string;
  bundle_restore_status?: ThreadBundleRestoreStatus;
  last_bundle_restore_error?: string;
}

export function markThreadRunning(
  threadKey: string,
  cwd: string,
  updates: ThreadStateRunningUpdates,
  opts?: PushOptions,
): ThreadState {
  const existing = fetchThreadState(threadKey, cwd, opts);

  let state: ThreadState;
  if (existing) {
    state = updateThreadState(existing, {
      status: "running",
      attempt_count: existing.attempt_count + 1,
      last_run_url: updates.last_run_url ?? existing.last_run_url,
      branch: updates.branch ?? existing.branch,
      resume_status: updates.resume_status ?? "not_attempted",
      last_resume_error: updates.last_resume_error ?? "",
      resumed_from_session_id: updates.resumed_from_session_id ?? "",
      forked_from_thread_key: updates.forked_from_thread_key ?? existing.forked_from_thread_key,
      forked_from_acpx_session_id: updates.forked_from_acpx_session_id ?? existing.forked_from_acpx_session_id,
      bundle_restore_status: updates.bundle_restore_status ?? existing.bundle_restore_status,
      last_bundle_restore_error: updates.last_bundle_restore_error ?? existing.last_bundle_restore_error,
    });
  } else {
    state = updateThreadState(createThreadState(threadKey), {
      status: "running",
      attempt_count: 1,
      last_run_url: updates.last_run_url ?? "",
      branch: updates.branch ?? "",
      resume_status: updates.resume_status ?? "not_attempted",
      last_resume_error: updates.last_resume_error ?? "",
      resumed_from_session_id: updates.resumed_from_session_id ?? "",
      forked_from_thread_key: updates.forked_from_thread_key ?? "",
      forked_from_acpx_session_id: updates.forked_from_acpx_session_id ?? "",
      bundle_restore_status: updates.bundle_restore_status ?? "not_attempted",
      last_bundle_restore_error: updates.last_bundle_restore_error ?? "",
    });
  }

  writeThreadState(threadKey, state, cwd, opts);
  return state;
}

export interface ThreadStateCompletionUpdates {
  acpxRecordId?: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  branch?: string;
  last_comment_url?: string;
  resume_status?: ThreadResumeStatus;
  last_resume_error?: string;
  resumed_from_session_id?: string;
}

export function markThreadCompleted(
  threadKey: string,
  state: ThreadState,
  cwd: string,
  updates: ThreadStateCompletionUpdates,
  opts?: PushOptions,
): ThreadState {
  const next = updateThreadState(state, {
    ...updates,
    status: "completed",
  });
  writeThreadState(threadKey, next, cwd, opts);
  return next;
}

export interface ThreadStateFailureUpdates {
  last_comment_url?: string;
  resume_status?: ThreadResumeStatus;
  last_resume_error?: string;
  resumed_from_session_id?: string;
}

export function markThreadFailed(
  threadKey: string,
  state: ThreadState,
  cwd: string,
  updates: ThreadStateFailureUpdates,
  opts?: PushOptions,
): ThreadState {
  const next = updateThreadState(state, {
    ...updates,
    status: "failed",
  });
  writeThreadState(threadKey, next, cwd, opts);
  return next;
}

export interface ThreadStateBundleRestoreUpdates {
  bundle_restore_status?: ThreadBundleRestoreStatus;
  last_bundle_restore_error?: string;
}

export function markThreadBundleRestore(
  threadKey: string,
  cwd: string,
  updates: ThreadStateBundleRestoreUpdates,
  opts?: PushOptions,
): ThreadState | null {
  const existing = fetchThreadState(threadKey, cwd, opts);
  if (!existing) {
    return null;
  }

  const next = updateThreadState(existing, {
    bundle_restore_status: updates.bundle_restore_status ?? existing.bundle_restore_status,
    last_bundle_restore_error: updates.last_bundle_restore_error ?? existing.last_bundle_restore_error,
  });
  writeThreadState(threadKey, next, cwd, opts);
  return next;
}

export interface ThreadStateBundleStoredUpdates {
  session_bundle_backend?: string;
  session_bundle_artifact_id?: string;
  session_bundle_artifact_name?: string;
  session_bundle_run_id?: string;
}

export function markThreadBundleStored(
  threadKey: string,
  cwd: string,
  updates: ThreadStateBundleStoredUpdates,
  opts?: PushOptions,
): ThreadState {
  const existing = fetchThreadState(threadKey, cwd, opts) || createThreadState(threadKey);
  const next = updateThreadState(existing, {
    session_bundle_backend: updates.session_bundle_backend ?? existing.session_bundle_backend,
    session_bundle_artifact_id: updates.session_bundle_artifact_id ?? existing.session_bundle_artifact_id,
    session_bundle_artifact_name: updates.session_bundle_artifact_name ?? existing.session_bundle_artifact_name,
    session_bundle_run_id: updates.session_bundle_run_id ?? existing.session_bundle_run_id,
  });
  writeThreadState(threadKey, next, cwd, opts);
  return next;
}
