import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildSessionBundleArtifactName,
  createSessionBundle,
  discoverSessionBundleFiles,
  findSessionBundleArchive,
  formatSessionRestoreNotice,
  hasValidThreadTargetNumber,
  parseSessionBundleMode,
  restoreSessionBundle,
  shouldUseSessionBundles,
} from "../session-bundle.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("parseSessionBundleMode defaults to auto", () => {
  assert.equal(parseSessionBundleMode(undefined), "auto");
  assert.equal(parseSessionBundleMode(""), "auto");
  assert.equal(parseSessionBundleMode("ALWAYS"), "always");
  assert.equal(parseSessionBundleMode("never"), "never");
});

test("shouldUseSessionBundles follows auto and explicit mode semantics", () => {
  assert.equal(shouldUseSessionBundles("auto", "none"), false);
  assert.equal(shouldUseSessionBundles("auto", "track-only"), false);
  assert.equal(shouldUseSessionBundles("auto", "resume-best-effort"), true);
  assert.equal(shouldUseSessionBundles("auto", "resume-required"), true);
  assert.equal(shouldUseSessionBundles("always", "track-only"), true);
  assert.equal(shouldUseSessionBundles("never", "resume-required"), false);
});

test("hasValidThreadTargetNumber permits repository target_number=0", () => {
  assert.equal(hasValidThreadTargetNumber("repository", 0), true);
  assert.equal(hasValidThreadTargetNumber("repository", 1), true);
  assert.equal(hasValidThreadTargetNumber("issue", 0), false);
  assert.equal(hasValidThreadTargetNumber("pull_request", 42), true);
  assert.equal(hasValidThreadTargetNumber("discussion", Number.NaN), false);
});

test("session bundle CLIs tolerate repository target_number=0", () => {
  const cases = [
    {
      script: "session-restore.js",
      env: { SESSION_POLICY: "none", SESSION_BUNDLE_MODE: "auto" },
    },
    {
      script: "session-backup.js",
      env: {
        ACPX_AGENT: "codex",
        SESSION_POLICY: "resume-best-effort",
        SESSION_BUNDLE_MODE: "always",
      },
    },
    // Register skips without artifact metadata; the helper unit test covers validation.
    {
      script: "session-register.js",
      env: {
        SESSION_POLICY: "resume-best-effort",
        SESSION_BUNDLE_MODE: "always",
      },
    },
  ];

  for (const entry of cases) {
    const tempDir = makeTempDir("session-bundle-cli-");
    try {
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), "dist", "cli", entry.script)],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ...entry.env,
            GITHUB_OUTPUT: join(tempDir, "github-output"),
            GITHUB_REPOSITORY: "self-evolving/repo",
            ROUTE: "answer",
            TARGET_KIND: "repository",
            TARGET_NUMBER: "0",
          },
          encoding: "utf8",
        },
      );

      assert.equal(
        result.status,
        0,
        `${entry.script} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("buildSessionBundleArtifactName is deterministic and includes route identity", () => {
  const name = buildSessionBundleArtifactName(
    "self-evolving/repo:pull_request:99:fix-pr:default",
    "12345",
  );
  assert.match(name, /^session-bundle-pull_request-99-fix-pr-default-/);
  assert.match(name, /-12345$/);
  assert.equal(
    name,
    buildSessionBundleArtifactName(
      "self-evolving/repo:pull_request:99:fix-pr:default",
      "12345",
    ),
  );
});

test("formatSessionRestoreNotice reports fallback and failure outcomes", () => {
  assert.match(
    formatSessionRestoreNotice({ resumeStatus: "fallback_fresh", runStatus: "success" }),
    /continued with a fresh session/,
  );
  assert.match(
    formatSessionRestoreNotice({ resumeStatus: "failed", runStatus: "failed" }),
    /could not be restored/,
  );
  assert.equal(
    formatSessionRestoreNotice({ resumeStatus: "resumed", runStatus: "success" }),
    "",
  );
});

test("discoverSessionBundleFiles finds acpx and codex provider files under HOME", () => {
  const home = makeTempDir("session-bundle-home-");
  try {
    mkdirSync(join(home, ".acpx", "sessions"), { recursive: true });
    mkdirSync(join(home, ".codex", "sessions", "2026", "04", "08"), { recursive: true });

    writeFileSync(join(home, ".acpx", "sessions", "rec-1.json"), "{}\n");
    writeFileSync(join(home, ".acpx", "sessions", "rec-1.stream.ndjson"), "{}\n");
    writeFileSync(
      join(home, ".codex", "sessions", "2026", "04", "08", "rollout-ses-1.jsonl"),
      "hello\n",
    );

    const files = discoverSessionBundleFiles({
      agent: "codex",
      acpxRecordId: "rec-1",
      acpxSessionId: "ses-1",
      homeDir: home,
    });

    assert.deepEqual(
      files.map((file) => file.relative_path),
      [
        ".acpx/sessions/rec-1.json",
        ".acpx/sessions/rec-1.stream.ndjson",
        ".codex/sessions/2026/04/08/rollout-ses-1.jsonl",
      ],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverSessionBundleFiles treats session ids as literal text inside find globs", () => {
  const home = makeTempDir("session-bundle-home-literal-");
  try {
    mkdirSync(join(home, ".claude", "projects", "repo"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "projects", "repo", "abc[1].jsonl"),
      "literal\n",
    );

    const files = discoverSessionBundleFiles({
      agent: "claude",
      acpxRecordId: "",
      acpxSessionId: "abc[1]",
      homeDir: home,
    });

    assert.deepEqual(
      files.map((file) => file.relative_path),
      [".claude/projects/repo/abc[1].jsonl"],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("createSessionBundle and restoreSessionBundle round-trip files", () => {
  const sourceHome = makeTempDir("session-bundle-source-");
  const restoreHome = makeTempDir("session-bundle-restore-");
  const runnerTemp = makeTempDir("session-bundle-temp-");

  try {
    mkdirSync(join(sourceHome, ".acpx", "sessions"), { recursive: true });
    mkdirSync(join(sourceHome, ".codex", "sessions", "2026", "04", "08"), { recursive: true });

    writeFileSync(join(sourceHome, ".acpx", "sessions", "rec-2.json"), '{"ok":true}\n');
    writeFileSync(join(sourceHome, ".acpx", "sessions", "rec-2.stream.ndjson"), "stream\n");
    writeFileSync(
      join(sourceHome, ".codex", "sessions", "2026", "04", "08", "rollout-ses-2.jsonl"),
      "provider\n",
    );

    const bundle = createSessionBundle({
      agent: "codex",
      threadKey: "self-evolving/repo:pull_request:99:fix-pr:default",
      repoSlug: "self-evolving/repo",
      cwd: "/repo",
      acpxRecordId: "rec-2",
      acpxSessionId: "ses-2",
      homeDir: sourceHome,
      runnerTemp,
    });

    assert.ok(bundle);
    assert.equal(bundle?.fileCount, 3);
    assert.ok(findSessionBundleArchive(runnerTemp));

    const manifest = restoreSessionBundle(bundle!.bundlePath, restoreHome);
    assert.equal(manifest.acpx_record_id, "rec-2");
    assert.equal(manifest.acpx_session_id, "ses-2");

    assert.equal(
      readFileSync(join(restoreHome, ".acpx", "sessions", "rec-2.json"), "utf8"),
      '{"ok":true}\n',
    );
    assert.equal(
      readFileSync(join(restoreHome, ".codex", "sessions", "2026", "04", "08", "rollout-ses-2.jsonl"), "utf8"),
      "provider\n",
    );
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
    rmSync(restoreHome, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("restoreSessionBundle rejects checksum mismatches", () => {
  const sourceHome = makeTempDir("session-bundle-source-bad-hash-");
  const restoreHome = makeTempDir("session-bundle-restore-bad-hash-");
  const runnerTemp = makeTempDir("session-bundle-temp-bad-hash-");
  const extracted = makeTempDir("session-bundle-edit-bad-hash-");

  try {
    mkdirSync(join(sourceHome, ".acpx", "sessions"), { recursive: true });
    writeFileSync(join(sourceHome, ".acpx", "sessions", "rec-3.json"), '{"ok":true}\n');
    writeFileSync(join(sourceHome, ".acpx", "sessions", "rec-3.stream.ndjson"), "stream\n");

    const bundle = createSessionBundle({
      agent: "codex",
      threadKey: "self-evolving/repo:pull_request:100:fix-pr:default",
      repoSlug: "self-evolving/repo",
      cwd: "/repo",
      acpxRecordId: "rec-3",
      acpxSessionId: "ses-3",
      homeDir: sourceHome,
      runnerTemp,
    });

    assert.ok(bundle);

    const tamperedTgz = join(runnerTemp, "tampered.tgz");
    execFileSync("tar", ["-xzf", bundle!.bundlePath, "-C", extracted]);
    writeFileSync(join(extracted, "files", ".acpx", "sessions", "rec-3.json"), '{"ok":false}\n');
    execFileSync("tar", ["-czf", tamperedTgz, "-C", extracted, "manifest.json", "files"]);

    assert.throws(
      () => restoreSessionBundle(tamperedTgz, restoreHome),
      /checksum mismatch/,
    );
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
    rmSync(restoreHome, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
    rmSync(extracted, { recursive: true, force: true });
  }
});

test("restoreSessionBundle rejects paths that escape HOME", () => {
  const sourceHome = makeTempDir("session-bundle-source-escape-");
  const restoreHome = makeTempDir("session-bundle-restore-escape-");
  const runnerTemp = makeTempDir("session-bundle-temp-escape-");
  const extracted = makeTempDir("session-bundle-edit-escape-");

  try {
    mkdirSync(join(sourceHome, ".acpx", "sessions"), { recursive: true });
    writeFileSync(join(sourceHome, ".acpx", "sessions", "rec-4.json"), '{"ok":true}\n');
    writeFileSync(join(sourceHome, ".acpx", "sessions", "rec-4.stream.ndjson"), "stream\n");

    const bundle = createSessionBundle({
      agent: "codex",
      threadKey: "self-evolving/repo:pull_request:101:fix-pr:default",
      repoSlug: "self-evolving/repo",
      cwd: "/repo",
      acpxRecordId: "rec-4",
      acpxSessionId: "ses-4",
      homeDir: sourceHome,
      runnerTemp,
    });

    assert.ok(bundle);
    execFileSync("tar", ["-xzf", bundle!.bundlePath, "-C", extracted]);
    const manifestPath = join(extracted, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Array<{ relative_path: string }>;
    };
    manifest.files[0].relative_path = "../../escape.txt";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const tamperedTgz = join(runnerTemp, "tampered-escape.tgz");
    execFileSync("tar", ["-czf", tamperedTgz, "-C", extracted, "manifest.json", "files"]);

    assert.throws(
      () => restoreSessionBundle(tamperedTgz, restoreHome),
      /Invalid bundle path|escapes HOME/,
    );
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
    rmSync(restoreHome, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
    rmSync(extracted, { recursive: true, force: true });
  }
});
