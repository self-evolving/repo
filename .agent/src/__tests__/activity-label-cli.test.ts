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

function runActivityLabel(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/activity-label.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...env,
    },
    encoding: "utf8",
  });
}

test("activity-label CLI creates and applies route running labels", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-activity-label-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "label" ] && [ "$2" = "list" ]; then
  exit 0
fi
if [ "$1" = "label" ] && [ "$2" = "create" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runActivityLabel(tempDir, {
      ACTIVITY_LABEL_ACTION: "add",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      ROUTE: "review",
      TARGET_KIND: "pull_request",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^label list --search agent-running\/review --json name --jq \.\[\]\.name --repo self-evolving\/repo$/m);
    assert.match(
      log,
      /^label create agent-running\/review --color bf3989 --description Sepo is reviewing this pull request --repo self-evolving\/repo$/m,
    );
    assert.match(log, /^pr edit 42 --add-label agent-running\/review --repo self-evolving\/repo$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("activity-label CLI removes route running labels without ensuring them", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-activity-label-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runActivityLabel(tempDir, {
      ACTIVITY_LABEL_ACTION: "remove",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      ROUTE: "orchestrate",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "25",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, /^label /m);
    assert.match(log, /^issue edit 25 --remove-label agent-running\/orchestrate --repo self-evolving\/repo$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("activity-label CLI skips unsupported routes before calling gh", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-activity-label-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 1
`,
    );

    const result = runActivityLabel(tempDir, {
      ACTIVITY_LABEL_ACTION: "add",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      ROUTE: "answer",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /has no activity label/);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
