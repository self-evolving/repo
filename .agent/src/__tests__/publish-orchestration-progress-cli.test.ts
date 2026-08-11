import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function runPublisher(options: {
  policy: string;
  ghExit?: number;
  comments?: Array<Record<string, unknown>>;
}): {
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
if [ "\${1-}" = "api" ] && [ "\${2-}" = "graphql" ]; then
  printf '{"data":{"viewer":{"login":"sepo-agent-app[bot]"}}}\\n'
  exit 0
fi
if [ "\${1-}" = "api" ] && [ "\${2-}" = "--paginate" ] && [ "\${3-}" = "--slurp" ]; then
  printf '%s\\n' "$FAKE_ISSUE_COMMENTS_JSON"
  exit 0
fi
if [ "\${1-}" = "api" ] && [ "\${2-}" = "--method" ] && { [ "\${3-}" = "POST" ] || [ "\${3-}" = "PATCH" ]; }; then
  if [ "${options.ghExit || 0}" -ne 0 ]; then
    printf 'comment publication denied\\n' >&2
    exit ${options.ghExit || 0}
  fi
  if [ "\${3-}" = "POST" ]; then
    printf '4242\\n'
  fi
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
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
          FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([options.comments || []]),
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

test("report-only orchestration progress reuses a trusted same-run comment", () => {
  const run = runPublisher({
    policy: '{"orchestration_mode":"report-only"}',
    comments: [
      {
        id: 7171,
        body: "Earlier attempt.\n\n<!-- sepo-progress:run-12345 -->",
        created_at: "2026-08-10T19:00:00Z",
        user: { login: "sepo-agent-app[bot]" },
      },
      {
        id: 8181,
        body: "Prior attempt.\n\n<!-- sepo-progress:run-12345 -->",
        created_at: "2026-08-10T20:00:00Z",
        user: { login: "sepo-agent-app[bot]" },
      },
      {
        id: 9191,
        body: "Forged marker.\n\n<!-- sepo-progress:run-12345 -->",
        created_at: "2026-08-10T21:00:00Z",
        user: { login: "someone-else" },
      },
    ],
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.ghLog, /api --method PATCH repos\/self-evolving\/repo\/issues\/comments\/8181/);
  assert.doesNotMatch(run.ghLog, /issues\/comments\/(?:7171|9191)/);
  assert.doesNotMatch(run.ghLog, /api --method POST repos\/self-evolving\/repo\/issues\/495\/comments/);
  assert.match(run.output, /8181/);
  assert.match(run.stdout, /Updated orchestration progress comment 8181\./);
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
