import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { persistSessionRunState } from "../session-state-persistence.js";
import { createSessionBundle } from "../session-bundle.js";
import {
  fetchThreadState,
  markThreadBundleStored,
  refPathForThreadKey,
} from "../thread-state.js";

const THREAD_KEY = "self-evolving/repo:pull_request:495:orchestrator:planner";

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString("utf8").trim();
}

function configureTestRepo(dir: string): void {
  gitIn(dir, ["config", "user.name", "test"]);
  gitIn(dir, ["config", "user.email", "test@test.com"]);
}

test("deferred planner state and bundle metadata survive onto a new runner", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-session-state-"));
  const remote = join(root, "remote.git");
  const firstRunner = join(root, "round-1");
  const secondRunner = join(root, "round-2");
  const sourceHome = join(root, "source-home");
  const restoredHome = join(root, "restored-home");
  const bundleTemp = join(root, "bundle-temp");
  const fakeBin = join(root, "bin");
  const githubOutput = join(root, "github-output");

  try {
    execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    execFileSync("git", ["clone", remote, firstRunner], { stdio: "pipe" });
    configureTestRepo(firstRunner);

    const first = persistSessionRunState({
      repoRoot: firstRunner,
      repoSlug: "self-evolving/repo",
      route: "orchestrator",
      targetKind: "pull_request",
      targetNumber: 495,
      lane: "planner",
      expectedThreadKey: THREAD_KEY,
      exitCode: 0,
      acpxRecordId: "record-round-1",
      acpxSessionId: "session-round-1",
      resumeStatus: "not_attempted",
      bundleRestoreStatus: "not_available",
      lastRunUrl: "https://github.com/self-evolving/repo/actions/runs/1",
    });
    assert.equal(first.status, "completed");
    assert.equal(first.attempt_count, 1);

    mkdirSync(join(sourceHome, ".acpx", "sessions"), { recursive: true });
    mkdirSync(join(sourceHome, ".codex", "sessions", "2026", "08", "10"), {
      recursive: true,
    });
    mkdirSync(bundleTemp, { recursive: true });
    writeFileSync(
      join(sourceHome, ".acpx", "sessions", "record-round-1.json"),
      '{"session":"round-1"}\n',
    );
    writeFileSync(
      join(sourceHome, ".codex", "sessions", "2026", "08", "10", "session-round-1.jsonl"),
      "round-1\n",
    );
    const bundle = createSessionBundle({
      agent: "codex",
      threadKey: THREAD_KEY,
      repoSlug: "self-evolving/repo",
      cwd: firstRunner,
      acpxRecordId: "record-round-1",
      acpxSessionId: "session-round-1",
      homeDir: sourceHome,
      runnerTemp: bundleTemp,
    });
    assert.ok(bundle);

    markThreadBundleStored(
      THREAD_KEY,
      firstRunner,
      {
        session_bundle_backend: "github-artifact",
        session_bundle_artifact_id: "101",
        session_bundle_artifact_name: "agent-session-round-1",
        session_bundle_run_id: "1",
      },
    );

    execFileSync("git", ["clone", remote, secondRunner], { stdio: "pipe" });
    configureTestRepo(secondRunner);
    const restored = fetchThreadState(THREAD_KEY, secondRunner);
    assert.ok(restored);
    assert.equal(restored.acpxSessionId, "session-round-1");
    assert.equal(restored.session_bundle_artifact_name, "agent-session-round-1");

    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(restoredHome, { recursive: true });
    writeFileSync(githubOutput, "", "utf8");
    const fakeGh = join(fakeBin, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node\nconst { copyFileSync } = require("node:fs");\nconst { join } = require("node:path");\nconst args = process.argv.slice(2);\nconst destination = args[args.indexOf("-D") + 1];\ncopyFileSync(${JSON.stringify(bundle!.bundlePath)}, join(destination, "session.tgz"));\n`,
      "utf8",
    );
    chmodSync(fakeGh, 0o755);
    const stateRef = refPathForThreadKey(THREAD_KEY);
    const stateBeforeRestore = gitIn(remote, ["rev-parse", stateRef]);
    const restore = spawnSync(
      process.execPath,
      [join(__dirname, "..", "cli", "session-restore.js")],
      {
        cwd: secondRunner,
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH || ""}`,
          DEFER_SESSION_STATE_PERSISTENCE: "true",
          GH_TOKEN: "",
          GITHUB_OUTPUT: githubOutput,
          GITHUB_REPOSITORY: "self-evolving/repo",
          GITHUB_TOKEN: "",
          GITHUB_WORKSPACE: secondRunner,
          HOME: restoredHome,
          INPUT_GITHUB_TOKEN: "",
          LANE: "planner",
          ROUTE: "orchestrator",
          RUNNER_TEMP: root,
          SESSION_BUNDLE_MODE: "auto",
          SESSION_POLICY: "resume-best-effort",
          TARGET_KIND: "pull_request",
          TARGET_NUMBER: "495",
        },
        encoding: "utf8",
      },
    );
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);
    assert.match(readFileSync(githubOutput, "utf8"), /restore_status<<[^\n]+\nrestored\n/);
    assert.equal(
      readFileSync(join(restoredHome, ".acpx", "sessions", "record-round-1.json"), "utf8"),
      '{"session":"round-1"}\n',
    );
    assert.equal(gitIn(remote, ["rev-parse", stateRef]), stateBeforeRestore);

    const second = persistSessionRunState({
      repoRoot: secondRunner,
      repoSlug: "self-evolving/repo",
      route: "orchestrator",
      targetKind: "pull_request",
      targetNumber: 495,
      lane: "planner",
      expectedThreadKey: THREAD_KEY,
      exitCode: 0,
      acpxRecordId: "record-round-2",
      acpxSessionId: "session-round-2",
      resumeStatus: "resumed",
      resumedFromSessionId: "session-round-1",
      bundleRestoreStatus: "restored",
      lastRunUrl: "https://github.com/self-evolving/repo/actions/runs/2",
    });

    assert.equal(second.status, "completed");
    assert.equal(second.attempt_count, 2);
    assert.equal(second.acpxSessionId, "session-round-2");
    assert.equal(second.resumed_from_session_id, "session-round-1");
    assert.equal(second.bundle_restore_status, "restored");
    assert.equal(second.session_bundle_artifact_name, "agent-session-round-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
