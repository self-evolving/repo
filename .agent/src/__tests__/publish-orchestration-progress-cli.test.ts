import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function runPublisher(options: { policy: string; ghExit?: number }): {
  status: number | null;
  stderr: string;
  stdout: string;
  ghLog: string;
  output: string;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-orchestration-progress-"));
  try {
    const fakeGh = join(tempDir, "gh");
    const ghLog = join(tempDir, "gh.log");
    const output = join(tempDir, "github-output.txt");
    writeFileSync(output, "", "utf8");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "${options.ghExit || 0}" -ne 0 ]; then
  printf 'comment publication denied\\n' >&2
  exit ${options.ghExit || 0}
fi
printf '4242\\n'
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const result = spawnSync(
      "node",
      [".agent/dist/cli/publish-orchestration-progress.js"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH || ""}`,
          AGENT_PROGRESS_POLICY: options.policy,
          FAKE_GH_LOG: ghLog,
          GH_TOKEN: "fake-token",
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "self-evolving/repo",
          GITHUB_RUN_ID: "12345",
          ROUTE: "orchestrator",
          TARGET_KIND: "pull_request",
          TARGET_NUMBER: "495",
        },
        encoding: "utf8",
      },
    );

    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      ghLog: existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "",
      output: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("report-only orchestration progress publishes through the trusted CLI", () => {
  const run = runPublisher({
    policy: '{"orchestration_mode":"report-only"}',
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.ghLog, /api --method POST repos\/self-evolving\/repo\/issues\/495\/comments/);
  assert.match(run.ghLog, /Sepo is working/);
  assert.match(run.ghLog, /<!-- sepo-progress:run-12345 -->/);
  assert.match(run.output, /progress_comment_id<</);
  assert.match(run.output, /4242/);
});

test("disabled orchestration progress performs no publication", () => {
  const run = runPublisher({ policy: "" });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.ghLog, "");
  assert.equal(run.output, "");
  assert.match(run.stdout, /orchestration progress skipped: mode=disabled/);
});

test("orchestration progress publication failures are visible", () => {
  const run = runPublisher({
    policy: '{"orchestration_mode":"report-only"}',
    ghExit: 1,
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /Failed to publish orchestration progress:/);
  assert.match(run.stderr, /comment publication denied/);
  assert.equal(run.output, "");
});
