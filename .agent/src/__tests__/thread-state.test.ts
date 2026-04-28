import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  THREAD_STATE_SCHEMA_VERSION,
  createThreadState,
  updateThreadState,
  normalizeThreadState,
  threadKeyToRefName,
  refPathForThreadKey,
  fetchThreadState,
  writeThreadState,
  markThreadRunning,
  markThreadCompleted,
  markThreadFailed,
  markThreadBundleRestore,
  markThreadBundleStored,
} from "../thread-state.js";

// ---------------------------------------------------------------------------
// Pure data operation tests
// ---------------------------------------------------------------------------

const TEST_KEY = "self-evolving/repo:issue:21:implement:default";

test("createThreadState produces a valid initial state", () => {
  const state = createThreadState(TEST_KEY);

  assert.equal(state.schema_version, THREAD_STATE_SCHEMA_VERSION);
  assert.equal(state.thread_key, TEST_KEY);
  assert.equal(state.acpxRecordId, "");
  assert.equal(state.acpxSessionId, "");
  assert.equal(state.agentSessionId, "");
  assert.equal(state.branch, "");
  assert.equal(state.status, "pending");
  assert.equal(state.resume_status, "not_attempted");
  assert.equal(state.last_resume_error, "");
  assert.equal(state.resumed_from_session_id, "");
  assert.equal(state.session_bundle_backend, "");
  assert.equal(state.session_bundle_artifact_id, "");
  assert.equal(state.session_bundle_artifact_name, "");
  assert.equal(state.session_bundle_run_id, "");
  assert.equal(state.bundle_restore_status, "not_attempted");
  assert.equal(state.last_bundle_restore_error, "");
  assert.equal(state.forked_from_thread_key, "");
  assert.equal(state.forked_from_acpx_session_id, "");
  assert.equal(state.last_run_url, "");
  assert.equal(state.last_comment_url, "");
  assert.equal(state.attempt_count, 0);
  assert.ok(state.created_at);
  assert.ok(state.updated_at);
});

test("updateThreadState merges updates and bumps updated_at", () => {
  const state = createThreadState(TEST_KEY);
  const originalCreated = state.created_at;

  const updated = updateThreadState(state, {
    status: "running",
    acpxRecordId: "rec-789",
    attempt_count: 1,
  });

  assert.equal(updated.thread_key, TEST_KEY);
  assert.equal(updated.status, "running");
  assert.equal(updated.acpxRecordId, "rec-789");
  assert.equal(updated.attempt_count, 1);
  assert.equal(updated.created_at, originalCreated);
  assert.ok(updated.updated_at >= originalCreated);
});

test("updateThreadState preserves thread_key even if updates try to change it", () => {
  const state = createThreadState(TEST_KEY);
  const updated = updateThreadState(state, { thread_key: "tampered" });
  assert.equal(updated.thread_key, TEST_KEY);
});

test("updateThreadState preserves created_at even if updates try to change it", () => {
  const state = createThreadState(TEST_KEY);
  const original = state.created_at;
  const updated = updateThreadState(state, { created_at: "2020-01-01T00:00:00Z" });
  assert.equal(updated.created_at, original);
});

test("normalizeThreadState upgrades legacy resume_failed state", () => {
  const legacy = normalizeThreadState({
    thread_key: TEST_KEY,
    status: "resume_failed",
    acpxSessionId: "ses-old",
    attempt_count: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T01:00:00Z",
  });

  assert.ok(legacy);
  assert.equal(legacy.schema_version, THREAD_STATE_SCHEMA_VERSION);
  assert.equal(legacy.status, "failed");
  assert.equal(legacy.resume_status, "failed");
  assert.equal(legacy.acpxSessionId, "ses-old");
  assert.equal(legacy.bundle_restore_status, "not_attempted");
  assert.equal(legacy.forked_from_thread_key, "");
  assert.equal(legacy.forked_from_acpx_session_id, "");
  assert.equal(legacy.attempt_count, 2);
});

// ---------------------------------------------------------------------------
// Ref naming tests
// ---------------------------------------------------------------------------

test("threadKeyToRefName converts slashes and colons", () => {
  assert.equal(
    threadKeyToRefName("self-evolving/repo:issue:42:implement:default"),
    "self-evolving%2Frepo--issue--42--implement--default",
  );
});

test("threadKeyToRefName handles special characters", () => {
  assert.equal(
    threadKeyToRefName("org/repo:pull_request:7:fix-pr:claude"),
    "org%2Frepo--pull_request--7--fix-pr--claude",
  );
});

test("threadKeyToRefName is injective: distinct keys with similar slugs don't collide", () => {
  const a = threadKeyToRefName("foo/bar-baz:issue:1:implement:default");
  const b = threadKeyToRefName("foo-bar/baz:issue:1:implement:default");
  assert.notEqual(a, b, "different repo slugs must produce different ref names");
});

test("threadKeyToRefName round-trips percent in key", () => {
  const a = threadKeyToRefName("org/%2F:issue:1:r:l");
  const b = threadKeyToRefName("org//::issue:1:r:l");
  assert.notEqual(a, b);
});

test("refPathForThreadKey produces full ref path", () => {
  assert.equal(
    refPathForThreadKey("self-evolving/repo:issue:42:implement:default"),
    "refs/agent-state/self-evolving%2Frepo--issue--42--implement--default",
  );
});

// ---------------------------------------------------------------------------
// Git integration test helpers
// ---------------------------------------------------------------------------

let remoteDir: string;
let workDir: string;

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString("utf8").trim();
}

function setupRepos(): void {
  const base = mkdtempSync(join(tmpdir(), "agent-ts-test-"));
  remoteDir = join(base, "remote.git");
  workDir = join(base, "work");

  execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
  execFileSync("git", ["clone", remoteDir, workDir], { stdio: "pipe" });

  // git commit-tree needs author/committer identity
  gitIn(workDir, ["config", "user.name", "test"]);
  gitIn(workDir, ["config", "user.email", "test@test.com"]);
}

function teardownRepos(): void {
  try {
    rmSync(join(remoteDir, ".."), { recursive: true, force: true });
  } catch { /* ok */ }
}

// ---------------------------------------------------------------------------
// Git integration tests
// ---------------------------------------------------------------------------

const GIT_TEST_KEY = "self-evolving/repo:issue:42:implement:default";

test("fetchThreadState returns null for nonexistent ref", () => {
  setupRepos();
  try {
    const result = fetchThreadState("nonexistent:key:1:route:lane", workDir);
    assert.equal(result, null);
  } finally {
    teardownRepos();
  }
});

test("writeThreadState + fetchThreadState round-trip", () => {
  setupRepos();
  try {
    const state = updateThreadState(createThreadState(GIT_TEST_KEY), {
      status: "running",
      attempt_count: 1,
      acpxRecordId: "rec-abc",
      acpxSessionId: "ses-def",
    });

    writeThreadState(GIT_TEST_KEY, state, workDir);

    const fetched = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.ok(fetched);
    assert.equal(fetched.thread_key, GIT_TEST_KEY);
    assert.equal(fetched.status, "running");
    assert.equal(fetched.attempt_count, 1);
    assert.equal(fetched.acpxRecordId, "rec-abc");
    assert.equal(fetched.acpxSessionId, "ses-def");
  } finally {
    teardownRepos();
  }
});

test("writeThreadState creates commit history (parent chain)", () => {
  setupRepos();
  try {
    const state1 = updateThreadState(createThreadState(GIT_TEST_KEY), {
      status: "running",
      attempt_count: 1,
    });
    writeThreadState(GIT_TEST_KEY, state1, workDir);

    const state2 = updateThreadState(state1, {
      status: "completed",
      attempt_count: 2,
    });
    writeThreadState(GIT_TEST_KEY, state2, workDir);

    const ref = refPathForThreadKey(GIT_TEST_KEY);
    const log = gitIn(workDir, ["log", "--oneline", ref]);
    const lines = log.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /completed.*attempt 2/);
    assert.match(lines[1], /running.*attempt 1/);
  } finally {
    teardownRepos();
  }
});

test("refs don't appear in normal branch listing", () => {
  setupRepos();
  try {
    const state = updateThreadState(createThreadState(GIT_TEST_KEY), {
      status: "running",
      attempt_count: 1,
    });
    writeThreadState(GIT_TEST_KEY, state, workDir);

    const branches = gitIn(workDir, ["branch", "-a"]);
    assert.ok(!branches.includes("agent-state"));
  } finally {
    teardownRepos();
  }
});

test("multiple thread keys produce independent refs", () => {
  setupRepos();
  try {
    const key1 = "org/repo:issue:1:implement:default";
    const key2 = "org/repo:issue:2:review:default";

    const state1 = updateThreadState(createThreadState(key1), {
      status: "running",
      attempt_count: 1,
    });
    const state2 = updateThreadState(createThreadState(key2), {
      status: "completed",
      attempt_count: 3,
    });

    writeThreadState(key1, state1, workDir);
    writeThreadState(key2, state2, workDir);

    const fetched1 = fetchThreadState(key1, workDir);
    const fetched2 = fetchThreadState(key2, workDir);

    assert.ok(fetched1);
    assert.ok(fetched2);
    assert.equal(fetched1.status, "running");
    assert.equal(fetched1.attempt_count, 1);
    assert.equal(fetched2.status, "completed");
    assert.equal(fetched2.attempt_count, 3);
  } finally {
    teardownRepos();
  }
});

test("markThreadRunning creates fresh state when none exists", () => {
  setupRepos();
  try {
    const state = markThreadRunning(GIT_TEST_KEY, workDir, {
      last_run_url: "https://github.com/org/repo/actions/runs/123",
    });

    assert.equal(state.status, "running");
    assert.equal(state.attempt_count, 1);
    assert.equal(state.last_run_url, "https://github.com/org/repo/actions/runs/123");
    assert.equal(state.forked_from_thread_key, "");
    assert.equal(state.forked_from_acpx_session_id, "");

    const fetched = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.ok(fetched);
    assert.equal(fetched.status, "running");
  } finally {
    teardownRepos();
  }
});

test("markThreadRunning bumps attempt_count on existing state", () => {
  setupRepos();
  try {
    markThreadRunning(GIT_TEST_KEY, workDir, {
      last_run_url: "run-1",
      forked_from_thread_key: "repo:issue:1:answer:default",
      forked_from_acpx_session_id: "ses-source",
      bundle_restore_status: "restored_from_fork",
      last_bundle_restore_error: "",
    });
    const state = markThreadRunning(GIT_TEST_KEY, workDir, { last_run_url: "run-2" });

    assert.equal(state.status, "running");
    assert.equal(state.attempt_count, 2);
    assert.equal(state.last_run_url, "run-2");
    assert.equal(state.forked_from_thread_key, "repo:issue:1:answer:default");
    assert.equal(state.forked_from_acpx_session_id, "ses-source");
    assert.equal(state.bundle_restore_status, "restored_from_fork");
  } finally {
    teardownRepos();
  }
});

test("markThreadCompleted sets status and identity", () => {
  setupRepos();
  try {
    const running = markThreadRunning(GIT_TEST_KEY, workDir, {});

    const completed = markThreadCompleted(GIT_TEST_KEY, running, workDir, {
      acpxRecordId: "rec-final",
      acpxSessionId: "ses-final",
    });

    assert.equal(completed.status, "completed");
    assert.equal(completed.acpxRecordId, "rec-final");
    assert.equal(completed.acpxSessionId, "ses-final");

    const fetched = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.ok(fetched);
    assert.equal(fetched.status, "completed");
    assert.equal(fetched.acpxRecordId, "rec-final");
  } finally {
    teardownRepos();
  }
});

test("markThreadCompleted always produces completed state", () => {
  setupRepos();
  try {
    const running = markThreadRunning(GIT_TEST_KEY, workDir, {});

    const completed = markThreadCompleted(GIT_TEST_KEY, running, workDir, {
      acpxRecordId: "rec-x",
    });

    assert.equal(completed.status, "completed");
    assert.equal(completed.acpxRecordId, "rec-x");

    const fetched = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.ok(fetched);
    assert.equal(fetched.status, "completed");
  } finally {
    teardownRepos();
  }
});

test("markThreadFailed records failed run status", () => {
  setupRepos();
  try {
    const running = markThreadRunning(GIT_TEST_KEY, workDir, {});

    const failed = markThreadFailed(GIT_TEST_KEY, running, workDir, {
      resume_status: "not_attempted",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.resume_status, "not_attempted");

    const fetched = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.ok(fetched);
    assert.equal(fetched.status, "failed");
    assert.equal(fetched.resume_status, "not_attempted");
  } finally {
    teardownRepos();
  }
});

test("markThreadFailed records resume failure separately from run failure", () => {
  setupRepos();
  try {
    const running = markThreadRunning(GIT_TEST_KEY, workDir, {});
    const failed = markThreadFailed(GIT_TEST_KEY, running, workDir, {
      resume_status: "failed",
      last_resume_error: "resume expired",
      resumed_from_session_id: "ses-old",
    });

    assert.equal(failed.status, "failed");
    assert.equal(failed.resume_status, "failed");
    assert.equal(failed.last_resume_error, "resume expired");
    assert.equal(failed.resumed_from_session_id, "ses-old");

    const fetched = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.ok(fetched);
    assert.equal(fetched.status, "failed");
    assert.equal(fetched.resume_status, "failed");
    assert.equal(fetched.resumed_from_session_id, "ses-old");
  } finally {
    teardownRepos();
  }
});

test("markThreadBundleRestore records restore outcomes independently", () => {
  setupRepos();
  try {
    markThreadRunning(GIT_TEST_KEY, workDir, {});

    const updated = markThreadBundleRestore(
      GIT_TEST_KEY,
      workDir,
      { bundle_restore_status: "failed", last_bundle_restore_error: "artifact expired" },
    );

    assert.ok(updated);
    assert.equal(updated.bundle_restore_status, "failed");
    assert.equal(updated.last_bundle_restore_error, "artifact expired");

    const fetched = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.ok(fetched);
    assert.equal(fetched.bundle_restore_status, "failed");
    assert.equal(fetched.last_bundle_restore_error, "artifact expired");
  } finally {
    teardownRepos();
  }
});

test("markThreadBundleRestore does not create fresh state on a missing thread", () => {
  setupRepos();
  try {
    const updated = markThreadBundleRestore(
      GIT_TEST_KEY,
      workDir,
      { bundle_restore_status: "not_available", last_bundle_restore_error: "" },
    );

    assert.equal(updated, null);
    const fetched = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.equal(fetched, null);
  } finally {
    teardownRepos();
  }
});

test("markThreadBundleStored records artifact pointer metadata", () => {
  setupRepos();
  try {
    const updated = markThreadBundleStored(
      GIT_TEST_KEY,
      workDir,
      {
        session_bundle_backend: "github-artifact",
        session_bundle_artifact_id: "123",
        session_bundle_artifact_name: "session-bundle-pr-42",
        session_bundle_run_id: "456",
      },
    );

    assert.equal(updated.session_bundle_backend, "github-artifact");
    assert.equal(updated.session_bundle_artifact_id, "123");
    assert.equal(updated.session_bundle_artifact_name, "session-bundle-pr-42");
    assert.equal(updated.session_bundle_run_id, "456");

    const fetched = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.ok(fetched);
    assert.equal(fetched.session_bundle_artifact_id, "123");
    assert.equal(fetched.session_bundle_run_id, "456");
  } finally {
    teardownRepos();
  }
});

test("full lifecycle: create → running → completed with identity", () => {
  setupRepos();
  try {
    // 1. First run starts
    const running = markThreadRunning(GIT_TEST_KEY, workDir, {
      last_run_url: "https://github.com/org/repo/actions/runs/100",
      branch: "agent/codex-42",
    });
    assert.equal(running.status, "running");
    assert.equal(running.attempt_count, 1);

    // 2. Run completes with session identity
    const completed = markThreadCompleted(GIT_TEST_KEY, running, workDir, {
      acpxRecordId: "rec-abc",
      acpxSessionId: "ses-def",
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.acpxRecordId, "rec-abc");

    // 3. Second run starts — reads prior state for resume
    const prior = fetchThreadState(GIT_TEST_KEY, workDir);
    assert.ok(prior);
    assert.equal(prior.acpxSessionId, "ses-def"); // available for resume

    const running2 = markThreadRunning(GIT_TEST_KEY, workDir, {
      last_run_url: "https://github.com/org/repo/actions/runs/200",
    });
    assert.equal(running2.attempt_count, 2);
    assert.equal(running2.acpxSessionId, "ses-def"); // preserved from prior

    // 4. Verify audit trail
    const ref = refPathForThreadKey(GIT_TEST_KEY);
    const log = gitIn(workDir, ["log", "--oneline", ref]);
    const lines = log.split("\n").filter(Boolean);
    assert.equal(lines.length, 3); // running(1) → completed → running(2)
  } finally {
    teardownRepos();
  }
});
