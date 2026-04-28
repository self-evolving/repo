import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveCursorActivity,
  resolveScheduledActivityGate,
} from "../scheduled-activity.js";

function runGit(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function runShellGate(env: Record<string, string>) {
  const tempDir = mkdtempSync(join(tmpdir(), "scheduled-gate-test-"));
  const outputFile = join(tempDir, "outputs.txt");
  const result = spawnSync("bash", ["scripts/resolve-scheduled-activity-gate.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "",
      GH_TOKEN: "",
      INPUT_GITHUB_TOKEN: "",
      REPO_SLUG: "",
      RUNNER_TEMP: tempDir,
      ...env,
    },
    encoding: "utf8",
  });
  const outputText = result.status === 0 ? readFileSync(outputFile, "utf8") : "";
  const payload = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { result, outputText, payload };
}

function createCursorWorkspace(dependencyValue: string, selfValue: string): string {
  const source = mkdtempSync(join(tmpdir(), "scheduled-gate-source-"));
  const bare = mkdtempSync(join(tmpdir(), "scheduled-gate-origin-"));
  const workspace = mkdtempSync(join(tmpdir(), "scheduled-gate-workspace-"));

  runGit(["init", "--bare"], bare);
  runGit(["init"], source);
  runGit(["config", "user.email", "sepo-agent@example.invalid"], source);
  runGit(["config", "user.name", "sepo-agent"], source);
  runGit(["remote", "add", "origin", bare], source);

  writeFileSync(join(source, "state.json"), `${JSON.stringify({ last_activity_at: dependencyValue })}\n`);
  runGit(["add", "state.json"], source);
  runGit(["commit", "-m", "sync state"], source);
  runGit(["push", "origin", "HEAD:refs/agent-memory-state/sync"], source);

  writeFileSync(join(source, "state.json"), `${JSON.stringify({ last_scan_at: selfValue })}\n`);
  runGit(["add", "state.json"], source);
  runGit(["commit", "-m", "scan state"], source);
  runGit(["push", "origin", "HEAD:refs/agent-memory-state/scan"], source);

  runGit(["init"], workspace);
  runGit(["remote", "add", "origin", bare], workspace);
  return workspace;
}

test("resolveScheduledActivityGate bypasses policy for manual runs", () => {
  const result = resolveScheduledActivityGate({
    eventName: "workflow_dispatch",
    schedulePolicy: '{"default_mode":"disabled"}',
    workflow: "agent-memory-scan.yml",
  });
  assert.equal(result.skip, false);
  assert.equal(result.mode, "disabled");
  assert.equal(result.reason, "non-scheduled run");
});

test("resolveScheduledActivityGate applies disabled and always_run modes", () => {
  const disabled = resolveScheduledActivityGate({
    eventName: "schedule",
    schedulePolicy: '{"default_mode":"disabled"}',
    workflow: "agent-memory-scan.yml",
  });
  assert.equal(disabled.skip, true);

  const alwaysRun = resolveScheduledActivityGate({
    eventName: "schedule",
    schedulePolicy: '{"default_mode":"skip_no_updates","workflow_overrides":{"agent-memory-sync.yml":"always_run"}}',
    workflow: "agent-memory-sync.yml",
  });
  assert.equal(alwaysRun.skip, false);
  assert.equal(alwaysRun.mode, "always_run");
});

test("resolveScheduledActivityGate uses activity count when provided", () => {
  const skipped = resolveScheduledActivityGate({
    eventName: "schedule",
    schedulePolicy: "",
    workflow: "agent-daily-summary.yml",
    activityCount: "0",
  });
  assert.equal(skipped.skip, true);
  assert.equal(skipped.reason, "activity count is zero");

  const run = resolveScheduledActivityGate({
    eventName: "schedule",
    schedulePolicy: "",
    workflow: "agent-daily-summary.yml",
    activityCount: "3",
  });
  assert.equal(run.skip, false);
  assert.equal(run.reason, "activity count is nonzero");
});

test("resolveScheduledActivityGate runs when skip_no_updates lacks detector config", () => {
  const result = resolveScheduledActivityGate({
    eventName: "schedule",
    schedulePolicy: '{"default_mode":"skip_no_updates"}',
    workflow: "agent-memory-sync.yml",
  });
  assert.equal(result.skip, false);
  assert.equal(result.reason, "missing activity cursor configuration");
});

test("scheduled-activity-gate shell script resolves disabled before runtime build", () => {
  const { result, outputText } = runShellGate({
    GITHUB_EVENT_NAME: "schedule",
    AGENT_SCHEDULE_POLICY: '{"default_mode":"disabled"}',
    WORKFLOW_FILENAME: "agent-memory-scan.yml",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"skip": true/);
  assert.match(outputText, /skip<<[\s\S]*true/);
});

test("scheduled-activity-gate shell script matches core gate modes", () => {
  for (const [name, env, expected] of [
    [
      "always_run override",
      {
        GITHUB_EVENT_NAME: "schedule",
        AGENT_SCHEDULE_POLICY:
          '{"default_mode":"skip_no_updates","workflow_overrides":{"agent-memory-sync.yml":"always_run"}}',
        WORKFLOW_FILENAME: "agent-memory-sync.yml",
      },
      { skip: false, mode: "always_run", reason: "schedule policy always_run" },
    ],
    [
      "activity count skip",
      {
        GITHUB_EVENT_NAME: "schedule",
        AGENT_SCHEDULE_POLICY: "",
        WORKFLOW_FILENAME: "agent-daily-summary.yml",
        ACTIVITY_COUNT: "0",
      },
      { skip: true, mode: "skip_no_updates", reason: "activity count is zero" },
    ],
    [
      "activity count run",
      {
        GITHUB_EVENT_NAME: "schedule",
        AGENT_SCHEDULE_POLICY: "",
        WORKFLOW_FILENAME: "agent-daily-summary.yml",
        ACTIVITY_COUNT: "3",
      },
      { skip: false, mode: "skip_no_updates", reason: "activity count is nonzero" },
    ],
  ] as const) {
    const { result, payload } = runShellGate(env);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.deepEqual(
      { skip: payload.skip, mode: payload.mode, reason: payload.reason },
      expected,
      name,
    );
  }
});

test("scheduled-activity-gate shell script rejects invalid policy", () => {
  const { result } = runShellGate({
    GITHUB_EVENT_NAME: "schedule",
    AGENT_SCHEDULE_POLICY: '{"default_mode":"banana"}',
    WORKFLOW_FILENAME: "agent-memory-scan.yml",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /default_mode must be one of/);
});

test("scheduled-activity-gate shell script compares cursor refs", () => {
  const skippedWorkspace = createCursorWorkspace(
    "2026-04-27T10:00:00Z",
    "2026-04-27T10:00:00.123Z",
  );
  const skipped = runShellGate({
    GITHUB_EVENT_NAME: "schedule",
    AGENT_SCHEDULE_POLICY: "",
    WORKFLOW_FILENAME: "agent-memory-scan.yml",
    DEPENDENCY_REF: "refs/agent-memory-state/sync",
    DEPENDENCY_FIELD: "last_activity_at",
    SELF_REF: "refs/agent-memory-state/scan",
    SELF_FIELD: "last_scan_at",
    GITHUB_WORKSPACE: skippedWorkspace,
  });
  assert.equal(skipped.result.status, 0, skipped.result.stderr);
  assert.equal(skipped.payload.skip, true);
  assert.equal(skipped.payload.reason, "dependency cursor has not advanced");

  const runWorkspace = createCursorWorkspace(
    "2026-04-27T11:00:00Z",
    "2026-04-27T10:00:00Z",
  );
  const run = runShellGate({
    GITHUB_EVENT_NAME: "schedule",
    AGENT_SCHEDULE_POLICY: "",
    WORKFLOW_FILENAME: "agent-memory-scan.yml",
    DEPENDENCY_REF: "refs/agent-memory-state/sync",
    DEPENDENCY_FIELD: "last_activity_at",
    SELF_REF: "refs/agent-memory-state/scan",
    SELF_FIELD: "last_scan_at",
    GITHUB_WORKSPACE: runWorkspace,
  });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.payload.skip, false);
  assert.equal(run.payload.reason, "dependency cursor advanced");
});

test("resolveCursorActivity skips only when dependency cursor has not advanced", () => {
  const skipped = resolveCursorActivity(
    "skip_no_updates",
    "2026-04-27T10:00:00Z",
    "2026-04-27T10:00:00Z",
  );
  assert.equal(skipped.skip, true);
  assert.equal(skipped.reason, "dependency cursor has not advanced");

  const run = resolveCursorActivity(
    "skip_no_updates",
    "2026-04-27T11:00:00Z",
    "2026-04-27T10:00:00Z",
  );
  assert.equal(run.skip, false);
  assert.equal(run.reason, "dependency cursor advanced");

  const missing = resolveCursorActivity("skip_no_updates", "", "2026-04-27T10:00:00Z");
  assert.equal(missing.skip, false);
  assert.equal(missing.reason, "missing or invalid activity cursor");
});
