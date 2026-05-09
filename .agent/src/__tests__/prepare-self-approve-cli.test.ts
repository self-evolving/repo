import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function runPrepareSelfApprove(env: Record<string, string>, tempDir: string): {
  status: number | null;
  output: string;
  stderr: string;
} {
  const outputFile = join(tempDir, "github-output");
  writeFileSync(outputFile, "", "utf8");
  const result = spawnSync("node", [".agent/dist/cli/prepare-self-approve.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      GITHUB_OUTPUT: outputFile,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: readFileSync(outputFile, "utf8"),
    stderr: result.stderr,
  };
}

test("prepare-self-approve stops when self-approval is disabled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-approve-prepare-"));
  try {
    const result = runPrepareSelfApprove({
      AGENT_ALLOW_SELF_APPROVE: "false",
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "pull_request",
      TARGET_NUMBER: "42",
    }, tempDir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /should_run<<[^\n]+\nfalse/);
    assert.match(result.output, /AGENT_ALLOW_SELF_APPROVE is not enabled/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepare-self-approve stops on non-PR targets before reading GitHub", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-approve-prepare-"));
  try {
    const result = runPrepareSelfApprove({
      AGENT_ALLOW_SELF_APPROVE: "true",
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "42",
    }, tempDir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /should_run<<[^\n]+\nfalse/);
    assert.match(result.output, /only supported for pull requests/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepare-self-approve stops on closed pull requests", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-approve-prepare-"));
  try {
    const logPath = join(tempDir, "gh.log");
    writeFileSync(join(tempDir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"headRefName":"agent/test","headRefOid":"abc123","isCrossRepository":false,"state":"CLOSED"}\\n'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, { encoding: "utf8", mode: 0o755 });

    const result = runPrepareSelfApprove({
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      AGENT_ALLOW_SELF_APPROVE: "true",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "pull_request",
      TARGET_NUMBER: "42",
    }, tempDir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /should_run<<[^\n]+\nfalse/);
    assert.match(result.output, /pull request is closed/);
    assert.match(readFileSync(logPath, "utf8"), /^pr view 42 /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
