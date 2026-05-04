import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function writeFakeGh(tempDir: string, body: string): void {
  writeFileSync(join(tempDir, "gh"), body, { encoding: "utf8", mode: 0o755 });
}

function runAssignAgent(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/assign-agent.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...env,
    },
    encoding: "utf8",
  });
}

test("assign-agent CLI defaults from AGENT_HANDLE and assigns issues", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-assign-agent-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "repos/self-evolving/repo/assignees/sepo-agent" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "POST" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runAssignAgent(tempDir, {
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Assigned issue #42 to @sepo-agent/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api repos\/self-evolving\/repo\/assignees\/sepo-agent$/m);
    assert.match(
      log,
      /^api -X POST repos\/self-evolving\/repo\/issues\/42\/assignees -f assignees\[\]=sepo-agent$/m,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("assign-agent CLI checks pull request assignability before assigning", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-assign-agent-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "repos/self-evolving/repo/assignees/octo-agent" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "POST" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runAssignAgent(tempDir, {
      AGENT_HANDLE: "@octo-agent",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "pull_request",
      TARGET_NUMBER: "12",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Assigned pull request #12 to @octo-agent/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api repos\/self-evolving\/repo\/assignees\/octo-agent$/m);
    assert.match(
      log,
      /^api -X POST repos\/self-evolving\/repo\/issues\/12\/assignees -f assignees\[\]=octo-agent$/m,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("assign-agent CLI warns and skips when the handle is not a user login", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-assign-agent-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 1
`,
    );

    const result = runAssignAgent(tempDir, {
      AGENT_HANDLE: "@self-evolving/sepo-agent",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0);
    assert.match(result.stderr, /assignment requires a user login/);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("assign-agent CLI warns without assigning when the login is not assignable", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-assign-agent-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "repos/self-evolving/repo/assignees/sepo-agent" ]; then
  exit 1
fi
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "POST" ]; then
  printf 'should not assign\\n' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runAssignAgent(tempDir, {
      AGENT_HANDLE: "@sepo-agent",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0);
    assert.match(result.stderr, /not assignable/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api repos\/self-evolving\/repo\/assignees\/sepo-agent$/m);
    assert.doesNotMatch(log, /^api -X POST /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
