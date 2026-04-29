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

function runCli(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/post-project-management-summary.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...env,
    },
    encoding: "utf8",
  });
}

test("post project management summary writes the Actions step summary without discussion posting", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "project-summary-"));

  try {
    const bodyFile = join(tempDir, "summary.md");
    const stepSummary = join(tempDir, "step-summary.md");
    const outputs = join(tempDir, "outputs.txt");
    writeFileSync(bodyFile, "## Project Management Summary\n\n- Mode: dry run\n");

    const result = runCli(tempDir, {
      AGENT_PROJECT_MANAGEMENT_POST_SUMMARY: "false",
      BODY_FILE: bodyFile,
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: stepSummary,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /posting is disabled/);
    assert.match(readFileSync(stepSummary, "utf8"), /Mode: dry run/);
    assert.match(readFileSync(outputs, "utf8"), /summary_posted<<.*\nfalse\n/s);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post project management summary comments on today's Daily Summary discussion when enabled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "project-summary-"));

  try {
    const bodyFile = join(tempDir, "summary.md");
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "outputs.txt");
    const stepSummary = join(tempDir, "step-summary.md");
    writeFileSync(bodyFile, "## Project Management Summary\n\n- Mode: labels applied\n");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  if printf '%s\n' "$*" | grep -q 'discussions(first'; then
    printf '{"data":{"repository":{"discussions":{"nodes":[{"id":"D_1","number":7,"title":"Daily Summary — 2026-04-29","url":"https://github.com/self-evolving/repo/discussions/7","category":{"name":"General"}}]}}}}'
    exit 0
  fi
  if printf '%s\n' "$*" | grep -q 'addDiscussionComment'; then
    printf '{"data":{"addDiscussionComment":{"comment":{"url":"https://github.com/self-evolving/repo/discussions/7#discussioncomment-1"}}}}'
    exit 0
  fi
fi
printf 'unexpected gh args: %s\n' "$*" >&2
exit 1
`,
    );

    const result = runCli(tempDir, {
      AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY: "General",
      AGENT_PROJECT_MANAGEMENT_POST_SUMMARY: "true",
      AGENT_PROJECT_MANAGEMENT_SUMMARY_DATE: "2026-04-29",
      BODY_FILE: bodyFile,
      FAKE_GH_LOG: logPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      GITHUB_STEP_SUMMARY: stepSummary,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Posted project management summary to https:\/\/github\.com\/self-evolving\/repo\/discussions\/7/);

    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api graphql /m);
    assert.match(log, /addDiscussionComment/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
