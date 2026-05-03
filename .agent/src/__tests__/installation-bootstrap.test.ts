import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function writeFakeGh(tempDir: string, body: string): void {
  writeFileSync(join(tempDir, "gh"), body, { encoding: "utf8", mode: 0o755 });
}

function runBootstrap(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/installation-bootstrap.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      GITHUB_OUTPUT: join(tempDir, "github-output"),
      RUNNER_TEMP: tempDir,
      ...env,
    },
    encoding: "utf8",
  });
}

test("installation-bootstrap dispatches onboarding when workflow exists", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-install-bootstrap-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "GET" ] && [[ "$4" == repos/*/contents/.github/workflows/agent-onboarding.yml ]]; then
  printf '{"path":".github/workflows/agent-onboarding.yml"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "POST" ]; then
  cat >/dev/null
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runBootstrap(tempDir, {
      DEFAULT_BRANCH: "main",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      INSTALLATION_ID: "123",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Sepo installation bootstrap dispatched/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api --method GET repos\/self-evolving\/repo\/contents\/.github\/workflows\/agent-onboarding.yml -f ref=main$/m);
    assert.match(log, /^api -X POST repos\/self-evolving\/repo\/actions\/workflows\/agent-onboarding.yml\/dispatches --input -$/m);
    assert.doesNotMatch(log, /^issue create /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installation-bootstrap creates fallback setup issue when workflow is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-install-bootstrap-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "GET" ] && [[ "$4" == repos/*/contents/.github/workflows/agent-onboarding.yml ]]; then
  exit 1
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '[]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  printf 'https://github.com/self-evolving/repo/issues/88\\n'
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/issues/88/comments ]]; then
  printf '[]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runBootstrap(tempDir, {
      DEFAULT_BRANCH: "main",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      INSTALLATION_ID: "123",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /setup issue is #88/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^issue create --title Sepo setup check --body-file .+ --repo self-evolving\/repo$/m);
    assert.match(log, /^issue comment 88 --body <!-- sepo-agent-installation-bootstrap -->/m);
    assert.match(log, /agent-onboarding.yml` was not found/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installation-bootstrap updates fallback comment when dispatch fails", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-install-bootstrap-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "GET" ] && [[ "$4" == repos/*/contents/.github/workflows/agent-onboarding.yml ]]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "POST" ]; then
  printf 'Actions is disabled' >&2
  exit 1
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '[{"number":9,"title":"Sepo setup check"}]'
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/issues/9/comments ]]; then
  printf '[{"id":456,"body":"<!-- sepo-agent-installation-bootstrap --> old"}]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "PATCH" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runBootstrap(tempDir, {
      DEFAULT_BRANCH: "main",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, /^issue create /m);
    assert.match(log, /^api -X PATCH repos\/self-evolving\/repo\/issues\/comments\/456 -f body=<!-- sepo-agent-installation-bootstrap -->/m);
    assert.match(log, /Workflow dispatch failed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
