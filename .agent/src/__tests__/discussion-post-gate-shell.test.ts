import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

function writeFakeGh(tempDir: string, responses: string | string[]): void {
  const responseList = Array.isArray(responses) ? responses : [responses];
  responseList.forEach((response, index) => {
    writeFileSync(join(tempDir, `response-${index}.json`), response);
  });

  writeFileSync(
    join(tempDir, "gh"),
    `#!/usr/bin/env bash
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  count_file="${join(tempDir, "gh-count")}"
  count="$(cat "$count_file" 2>/dev/null || printf '0')"
  response_file="${join(tempDir, "response-")}$count.json"
  next_count="$((count + 1))"
  printf '%s' "$next_count" > "$count_file"
  if [ -f "$response_file" ]; then
    cat "$response_file"
    exit 0
  fi
  printf 'missing fake gh response: %s\\n' "$response_file" >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    { encoding: "utf8", mode: 0o755 },
  );
}

function runGate(tempDir: string, env: Record<string, string>) {
  const outputFile = join(tempDir, "outputs.txt");
  const result = spawnSync("bash", ["scripts/resolve-discussion-post-gate.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "self-evolving/repo",
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...env,
    },
    encoding: "utf8",
  });
  const outputText = result.status === 0 ? readFileSync(outputFile, "utf8") : "";
  const payload = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { result, outputText, payload };
}

test("discussion post gate skips when repository discussions are disabled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "discussion-gate-"));
  try {
    writeFakeGh(tempDir, '{"data":{"repository":{"hasDiscussionsEnabled":false,"discussionCategories":{"nodes":[]}}}}');

    const { result, outputText, payload } = runGate(tempDir, {
      DISCUSSION_CATEGORY: "General",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(payload.skip, true);
    assert.equal(payload.reason, "repository discussions are disabled");
    assert.match(outputText, /skip<<[\s\S]*true/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("discussion post gate skips when the configured category is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "discussion-gate-"));
  try {
    writeFakeGh(
      tempDir,
      '{"data":{"repository":{"hasDiscussionsEnabled":true,"discussionCategories":{"nodes":[{"name":"General"}]}}}}',
    );

    const { result, payload } = runGate(tempDir, {
      DISCUSSION_CATEGORY: "Daily Summaries",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(payload.skip, true);
    assert.equal(payload.reason, "discussion category 'Daily Summaries' was not found");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("discussion post gate allows summary generation when posting is available", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "discussion-gate-"));
  try {
    writeFakeGh(
      tempDir,
      '{"data":{"repository":{"hasDiscussionsEnabled":true,"discussionCategories":{"nodes":[{"name":"General"}]}}}}',
    );

    const { result, payload } = runGate(tempDir, {
      DISCUSSION_CATEGORY: "General",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(payload.skip, false);
    assert.equal(payload.reason, "discussion posting is available");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("discussion post gate paginates categories before deciding posting is available", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "discussion-gate-"));
  try {
    writeFakeGh(tempDir, [
      '{"data":{"repository":{"hasDiscussionsEnabled":true,"discussionCategories":{"nodes":[{"name":"General"}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor-1"}}}}}',
      '{"data":{"repository":{"hasDiscussionsEnabled":true,"discussionCategories":{"nodes":[{"name":"Daily Summaries"}],"pageInfo":{"hasNextPage":false,"endCursor":"cursor-2"}}}}}',
    ]);

    const { result, payload } = runGate(tempDir, {
      DISCUSSION_CATEGORY: "Daily Summaries",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(tempDir, "gh-count"), "utf8"), "2");
    assert.equal(payload.skip, false);
    assert.equal(payload.reason, "discussion posting is available");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
