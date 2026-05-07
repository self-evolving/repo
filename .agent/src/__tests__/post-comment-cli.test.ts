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

test("post-comment CLI collapses previous fix-pr status comments", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-post-comment-"));

  try {
    const countPath = join(tempDir, "graphql-count.txt");
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "github-output.txt");
    const responsePath = join(tempDir, "response.json");
    writeFileSync(responsePath, '{"summary":"Updated tests."}\n', "utf8");
    writeFileSync(outputPath, "", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  count="$(cat "$FAKE_GH_COUNT" 2>/dev/null || printf '0')"
  count="$((count + 1))"
  printf '%s' "$count" > "$FAKE_GH_COUNT"
  case "$count" in
    1)
      printf '{"data":{"viewer":{"login":"sepo-agent"}}}\\n'
      exit 0
      ;;
    2)
      printf '{"data":{"repository":{"pullRequest":{"comments":{"nodes":[{"id":"old-fix","body":"**Sepo pushed fixes for this PR.** Branch: \`agent/fix\`.\\\\n\\\\n<!-- sepo-agent-fix-pr-status -->","isMinimized":false,"author":{"login":"sepo-agent"}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}\\n'
      exit 0
      ;;
    3)
      printf '{"data":{"minimizeComment":{"minimizedComment":{"isMinimized":true}}}}\\n'
      exit 0
      ;;
  esac
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
        BRANCH: "agent/fix",
        COMMENT_TARGET: "pr",
        TARGET_NUMBER: "321",
        ROUTE: "fix-pr",
        STATUS: "success",
        RESPONSE_FILE: responsePath,
        REQUESTED_BY: "lolipopshock",
        GITHUB_REPOSITORY: "self-evolving/repo",
        GITHUB_OUTPUT: outputPath,
        FAKE_GH_COUNT: countPath,
        FAKE_GH_LOG: logPath,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Collapsed 1 previous fix-pr status comment/);

    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api graphql /m);
    assert.match(log, /id=old-fix/);
    assert.match(log, /^pr comment 321 --body \*\*Sepo pushed fixes for this PR\.\*\*/m);
    assert.match(log, /<!-- sepo-agent-fix-pr-status -->/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
