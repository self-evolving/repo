import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultProgressCancelMarkerFile,
  readProgressCancelMarker,
  reconcileProgressCancelStatus,
  writeProgressCancelMarker,
} from "../progress-cancel.js";

test("progress cancel marker path defaults under runner temp", () => {
  assert.equal(
    defaultProgressCancelMarkerFile({ RUNNER_TEMP: "/tmp/runner" }),
    "/tmp/runner/agent-progress-cancelled",
  );
  assert.equal(
    defaultProgressCancelMarkerFile({ AGENT_PROGRESS_CANCEL_MARKER_FILE: "/tmp/custom" }),
    "/tmp/custom",
  );
});

test("progress cancel marker writes and reads the cancelling login", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "progress-cancel-"));
  try {
    const marker = join(tempDir, "nested", "marker");

    writeProgressCancelMarker(marker, "@alice\nignored");

    assert.equal(readProgressCancelMarker(marker), "alice");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status reconciliation reports cancelled when marker is present", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "progress-cancel-"));
  try {
    const marker = join(tempDir, "agent-progress-cancelled");
    writeProgressCancelMarker(marker, "alice");

    assert.deepEqual(reconcileProgressCancelStatus({ status: "failed", markerFile: marker }), {
      status: "cancelled",
      cancelled: true,
      cancelledBy: "alice",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status reconciliation ignores failed marker state", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "progress-cancel-"));
  try {
    const marker = join(tempDir, "agent-progress-cancelled");

    writeProgressCancelMarker(marker, "alice", "failed");
    assert.deepEqual(reconcileProgressCancelStatus({ status: "failed", markerFile: marker }), {
      status: "failed",
      cancelled: false,
      cancelledBy: "",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status reconciliation preserves known statuses without a marker", () => {
  assert.deepEqual(reconcileProgressCancelStatus({ status: "verify_failed", markerFile: "/missing" }), {
    status: "verify_failed",
    cancelled: false,
    cancelledBy: "",
  });
  assert.deepEqual(reconcileProgressCancelStatus({ status: "surprise", markerFile: "/missing" }), {
    status: "failed",
    cancelled: false,
    cancelledBy: "",
  });
});
