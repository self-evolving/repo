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

test("post-comment CLI still posts review comments when summary minimization fails", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-post-comment-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "github-output.txt");
    const responsePath = join(tempDir, "response.txt");
    writeFileSync(responsePath, "Review body\n", "utf8");
    writeFileSync(outputPath, "", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf '{"errors":[{"message":"graphql unavailable"}]}\\n'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = spawnSync("node", [".agent/dist/cli/post-comment.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        COMMENT_TARGET: "pr",
        TARGET_NUMBER: "321",
        ROUTE: "review",
        RESPONSE_FILE: responsePath,
        REQUESTED_BY: "lolipopshock",
        GITHUB_REPOSITORY: "self-evolving/repo",
        GITHUB_OUTPUT: outputPath,
        FAKE_GH_LOG: logPath,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(
      result.stderr,
      /Failed to collapse previous AI review synthesis comments for self-evolving\/repo#321: gh api graphql returned errors: graphql unavailable/,
    );

    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api graphql /m);
    assert.match(log, /^pr comment 321 --body ## AI Review Synthesis/m);

    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /^comment_posted<</m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-comment CLI skips review summary minimization when disabled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-post-comment-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "github-output.txt");
    const responsePath = join(tempDir, "response.txt");
    writeFileSync(responsePath, "Review body\n", "utf8");
    writeFileSync(outputPath, "", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf 'unexpected minimization call\\n' >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = spawnSync("node", [".agent/dist/cli/post-comment.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        AGENT_COLLAPSE_OLD_REVIEWS: "false",
        COMMENT_TARGET: "pr",
        TARGET_NUMBER: "321",
        ROUTE: "review",
        RESPONSE_FILE: responsePath,
        REQUESTED_BY: "lolipopshock",
        GITHUB_REPOSITORY: "self-evolving/repo",
        GITHUB_OUTPUT: outputPath,
        FAKE_GH_LOG: logPath,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");

    const log = readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, /^api graphql /m);
    assert.match(log, /^pr comment 321 --body ## AI Review Synthesis/m);

    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /^comment_posted<</m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
