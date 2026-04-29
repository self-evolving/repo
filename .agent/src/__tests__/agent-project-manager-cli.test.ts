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

function runCli(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/agent-project-manager.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...env,
    },
    encoding: "utf8",
  });
}

test("project manager CLI skips all gh calls unless explicitly enabled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-project-manager-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 1
`,
    );

    const result = runCli(tempDir, {
      AGENT_PROJECT_MANAGEMENT_ENABLED: "",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Project management is disabled/);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("project manager CLI dry-runs scoring without editing labels", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-project-manager-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '[{"number":34,"title":"Critical security issue","body":"urgent","labels":[],"updatedAt":"2026-04-28T00:00:00Z","comments":3,"assignees":[]}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '[]'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runCli(tempDir, {
      AGENT_PROJECT_MANAGEMENT_ENABLED: "true",
      AGENT_PROJECT_MANAGEMENT_DRY_RUN: "true",
      AGENT_PROJECT_MANAGEMENT_APPLY_LABELS: "true",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Mode: dry run/);
    assert.match(result.stdout, /issue#34: Critical security issue/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^issue list --repo self-evolving\/repo --state open/m);
    assert.match(log, /^pr list --repo self-evolving\/repo --state open/m);
    assert.doesNotMatch(log, / issue edit | pr edit | label create /);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
