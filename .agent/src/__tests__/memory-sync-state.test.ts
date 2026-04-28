import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  MEMORY_SYNC_STATE_REF,
  MEMORY_SYNC_STATE_SCHEMA_VERSION,
  createMemorySyncState,
  normalizeMemorySyncState,
  updateMemorySyncState,
} from "../memory-sync-state.js";

test("MEMORY_SYNC_STATE_REF points to a dedicated ref namespace", () => {
  assert.equal(MEMORY_SYNC_STATE_REF, "refs/agent-memory-state/sync");
});

test("createMemorySyncState produces an empty cursor set", () => {
  const state = createMemorySyncState("owner/repo");
  assert.equal(state.repo_slug, "owner/repo");
  assert.equal(state.last_sync_at, "");
  assert.equal(state.last_activity_at, "");
  assert.deepEqual(state.cursors, { issues: "", pulls: "", discussions: "", commits: "" });
  assert.equal(state.schema_version, MEMORY_SYNC_STATE_SCHEMA_VERSION);
});

test("updateMemorySyncState merges cursors partially and refreshes updated_at", () => {
  const initial = createMemorySyncState("owner/repo");
  const next = updateMemorySyncState(initial, {
    last_sync_at: "2026-04-23T00:00:00Z",
    last_activity_at: "2026-04-22T12:00:00Z",
    cursors: { issues: "2026-04-22T00:00:00Z" },
    last_run_url: "https://example.com/run/1",
  });
  assert.equal(next.last_sync_at, "2026-04-23T00:00:00Z");
  assert.equal(next.last_activity_at, "2026-04-22T12:00:00Z");
  assert.equal(next.cursors.issues, "2026-04-22T00:00:00Z");
  assert.equal(next.cursors.pulls, "");
  assert.equal(next.last_run_url, "https://example.com/run/1");
  assert.ok(next.updated_at >= initial.updated_at);
  assert.equal(next.created_at, initial.created_at);
});

test("normalizeMemorySyncState rejects records without a repo slug", () => {
  assert.equal(normalizeMemorySyncState(null), null);
  assert.equal(normalizeMemorySyncState({}), null);
  assert.equal(normalizeMemorySyncState({ repo_slug: "" }), null);
});

test("normalizeMemorySyncState fills in missing cursor fields", () => {
  const state = normalizeMemorySyncState({
    repo_slug: "owner/repo",
    cursors: { issues: "x" },
  });
  assert.ok(state);
  assert.equal(state!.repo_slug, "owner/repo");
  assert.equal(state!.last_activity_at, "");
  assert.equal(state!.cursors.issues, "x");
  assert.equal(state!.cursors.pulls, "");
});
