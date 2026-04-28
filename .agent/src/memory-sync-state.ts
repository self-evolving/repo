// Ref-backed sync cursors for the memory branch.
//
// Stored at refs/agent-memory-state/sync as a one-file tree. Separate from the
// agent/memory branch so cursor updates don't pollute the memory content
// history and don't race with memory commits.

import { buildAuthUrl, git } from "./git.js";

export const MEMORY_SYNC_STATE_SCHEMA_VERSION = 1;
export const MEMORY_SYNC_STATE_REF = "refs/agent-memory-state/sync";
const STATE_FILENAME = "state.json";
const REF_NOT_FOUND_PATTERN = /couldn't find remote ref|no matching remote head/i;

export interface MemorySyncCursors {
  issues: string;
  pulls: string;
  discussions: string;
  commits: string;
}

export interface MemorySyncState {
  schema_version: number;
  repo_slug: string;
  last_sync_at: string;
  last_activity_at: string;
  cursors: MemorySyncCursors;
  last_run_url: string;
  created_at: string;
  updated_at: string;
}

interface MemorySyncStateRecord extends Record<string, unknown> {
  schema_version?: unknown;
  repo_slug?: unknown;
  last_sync_at?: unknown;
  last_activity_at?: unknown;
  cursors?: unknown;
  last_run_url?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface MemorySyncStateUpdates {
  last_sync_at?: string;
  last_activity_at?: string;
  cursors?: Partial<MemorySyncCursors>;
  last_run_url?: string;
}

export interface PushOptions {
  remote?: string;
  token?: string;
  repo?: string;
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toIsoOrNow(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function normalizeCursors(raw: unknown): MemorySyncCursors {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    issues: toStringOrEmpty(record.issues),
    pulls: toStringOrEmpty(record.pulls),
    discussions: toStringOrEmpty(record.discussions),
    commits: toStringOrEmpty(record.commits),
  };
}

function resolveRemoteTarget(remote: string, opts?: PushOptions): string {
  if (opts?.token && opts?.repo) return buildAuthUrl(opts.token, opts.repo);
  return remote;
}

export function createMemorySyncState(repoSlug: string): MemorySyncState {
  const now = new Date().toISOString();
  return {
    schema_version: MEMORY_SYNC_STATE_SCHEMA_VERSION,
    repo_slug: repoSlug,
    last_sync_at: "",
    last_activity_at: "",
    cursors: { issues: "", pulls: "", discussions: "", commits: "" },
    last_run_url: "",
    created_at: now,
    updated_at: now,
  };
}

export function updateMemorySyncState(
  state: MemorySyncState,
  updates: MemorySyncStateUpdates,
): MemorySyncState {
  return {
    ...state,
    last_sync_at: updates.last_sync_at ?? state.last_sync_at,
    last_activity_at: updates.last_activity_at ?? state.last_activity_at,
    cursors: { ...state.cursors, ...(updates.cursors || {}) },
    last_run_url: updates.last_run_url ?? state.last_run_url,
    schema_version: state.schema_version,
    repo_slug: state.repo_slug,
    created_at: state.created_at,
    updated_at: new Date().toISOString(),
  };
}

export function normalizeMemorySyncState(raw: unknown): MemorySyncState | null {
  if (!raw || typeof raw !== "object") return null;

  const record = raw as MemorySyncStateRecord;
  const repoSlug = toStringOrEmpty(record.repo_slug);
  if (!repoSlug) return null;

  const now = new Date().toISOString();
  return {
    schema_version: MEMORY_SYNC_STATE_SCHEMA_VERSION,
    repo_slug: repoSlug,
    last_sync_at: toStringOrEmpty(record.last_sync_at),
    last_activity_at: toStringOrEmpty(record.last_activity_at),
    cursors: normalizeCursors(record.cursors),
    last_run_url: toStringOrEmpty(record.last_run_url),
    created_at: toIsoOrNow(record.created_at, now),
    updated_at: toIsoOrNow(record.updated_at, now),
  };
}

export function fetchMemorySyncState(
  cwd: string,
  opts?: PushOptions,
): MemorySyncState | null {
  const origin = opts?.remote ?? "origin";
  const fetchTarget = resolveRemoteTarget(origin, opts);

  try {
    git(["fetch", "--no-tags", fetchTarget, `+${MEMORY_SYNC_STATE_REF}:${MEMORY_SYNC_STATE_REF}`], cwd);
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString("utf8") ?? String(err);
    if (REF_NOT_FOUND_PATTERN.test(stderr)) return null;
    throw err;
  }

  try {
    const json = git(["cat-file", "blob", `${MEMORY_SYNC_STATE_REF}:${STATE_FILENAME}`], cwd);
    return normalizeMemorySyncState(JSON.parse(json));
  } catch {
    return null;
  }
}

export function writeMemorySyncState(
  state: MemorySyncState,
  cwd: string,
  opts?: PushOptions,
): void {
  const origin = opts?.remote ?? "origin";
  const json = JSON.stringify(state, null, 2) + "\n";

  const blobSha = git(["hash-object", "-w", "--stdin"], cwd, json);
  const treeInput = `100644 blob ${blobSha}\t${STATE_FILENAME}\n`;
  const treeSha = git(["mktree"], cwd, treeInput);

  let parentArg: string[];
  let expectedOid: string | null = null;
  try {
    const parentSha = git(["rev-parse", "--verify", MEMORY_SYNC_STATE_REF], cwd);
    parentArg = ["-p", parentSha];
    expectedOid = parentSha;
  } catch {
    parentArg = [];
  }

  const commitSha = git(
    [
      "commit-tree",
      treeSha,
      ...parentArg,
      "-m",
      `memory-sync-state: ${state.last_sync_at || "unsynced"}`,
    ],
    cwd,
  );

  git(["update-ref", MEMORY_SYNC_STATE_REF, commitSha], cwd);

  const pushTarget = resolveRemoteTarget(origin, opts);
  const leaseArg = expectedOid
    ? `--force-with-lease=${MEMORY_SYNC_STATE_REF}:${expectedOid}`
    : "--force";
  git(["push", leaseArg, pushTarget, `${MEMORY_SYNC_STATE_REF}:${MEMORY_SYNC_STATE_REF}`], cwd);
}
