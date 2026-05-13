import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function parseGithubOutput(raw: string): Map<string, string> {
  const outputs = new Map<string, string>();
  const blocks = raw.matchAll(/^([^<\n]+)<<([^\n]+)\n([\s\S]*?)\n\2$/gm);
  for (const [, name, , value] of blocks) {
    outputs.set(name, value);
  }
  return outputs;
}

function writeFakeGh(tempDir: string): void {
  writeFileSync(join(tempDir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  view_count_file="\${FAKE_GH_VIEW_COUNT_FILE-\${FAKE_GH_LOG}.view-count}"
  view_count=0
  if [ -f "$view_count_file" ]; then
    view_count="$(cat "$view_count_file")"
  fi
  printf '%s\\n' "$((view_count + 1))" > "$view_count_file"
  auto_merge_request="\${FAKE_AUTO_MERGE_REQUEST-null}"
  is_draft="\${FAKE_IS_DRAFT-false}"
  merge_state="\${FAKE_MERGE_STATE-CLEAN}"
  mergeable="\${FAKE_MERGEABLE-MERGEABLE}"
  if [ "\${FAKE_READY_RECHECK-}" = "true" ] && [ "$view_count" -gt 0 ]; then
    is_draft="\${FAKE_AFTER_READY_IS_DRAFT-false}"
    merge_state="\${FAKE_AFTER_READY_MERGE_STATE-CLEAN}"
    mergeable="\${FAKE_AFTER_READY_MERGEABLE-MERGEABLE}"
  fi
  printf '{"headRefOid":"abc123","isDraft":%s,"state":"%s","mergeStateStatus":"%s","mergeable":"%s","reviewDecision":"%s","statusCheckRollup":%s,"autoMergeRequest":%s}\\n' \
    "$is_draft" \
    "\${FAKE_PR_STATE-OPEN}" \
    "$merge_state" \
    "$mergeable" \
    "\${FAKE_REVIEW_DECISION-APPROVED}" \
    "\${FAKE_STATUS_CHECK_ROLLUP-[]}" \
    "$auto_merge_request"
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf '{"data":{"viewer":{"login":"sepo-agent-app[bot]"}}}\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ]; then
  printf '[[{"id":123,"state":"APPROVED","body":"Sepo self-approval completed. <!-- sepo-agent-self-approval -->","commit_id":"%s","submitted_at":"2026-05-10T10:00:00Z","user":{"login":"sepo-agent-app"}}]]\\n' "\${FAKE_APPROVAL_HEAD-abc123}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, { encoding: "utf8", mode: 0o755 });
}

function runResolveSelfMerge(tempDir: string, env: Record<string, string> = {}): {
  status: number | null;
  stderr: string;
  outputs: Map<string, string>;
  log: string;
} {
  const outputFile = join(tempDir, "github-output");
  writeFileSync(outputFile, "", "utf8");
  const result = spawnSync("node", [".agent/dist/cli/resolve-self-merge.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      AGENT_ALLOW_SELF_MERGE: env.AGENT_ALLOW_SELF_MERGE || "true",
      FAKE_GH_LOG: join(tempDir, "gh.log"),
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "pull_request",
      TARGET_NUMBER: "42",
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stderr: result.stderr,
    outputs: parseGithubOutput(readFileSync(outputFile, "utf8")),
    log: readFileSync(join(tempDir, "gh.log"), "utf8"),
  };
}

test("resolve-self-merge merges immediately when preflight passes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "merged");
    assert.equal(result.outputs.get("merged"), "true");
    assert.equal(result.outputs.get("status_post"), "true");
    assert.match(readFileSync(result.outputs.get("body_file") || "", "utf8"), /<!-- sepo-agent-self-merge -->/);
    assert.match(result.log, /^pr merge 42 --repo self-evolving\/repo --merge --match-head-commit abc123$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge enables auto-merge when checks are pending", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, {
      FAKE_MERGE_STATE: "BLOCKED",
      FAKE_MERGEABLE: "UNKNOWN",
      FAKE_STATUS_CHECK_ROLLUP: '[{"name":"check","status":"IN_PROGRESS","conclusion":""}]',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "auto_merge_enabled");
    assert.equal(result.outputs.get("auto_merge_enabled"), "true");
    assert.equal(result.outputs.get("status_post"), "true");
    assert.match(result.log, /^pr merge 42 --repo self-evolving\/repo --merge --auto --match-head-commit abc123$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge blocks auto-merge when merge state is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, {
      FAKE_MERGE_STATE: "",
      FAKE_MERGEABLE: "UNKNOWN",
      FAKE_STATUS_CHECK_ROLLUP: '[{"name":"check","status":"IN_PROGRESS","conclusion":""}]',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "blocked");
    assert.match(result.outputs.get("reason") || "", /merge state: unknown/);
    assert.doesNotMatch(result.log, /^pr merge /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge blocks existing auto-merge when merge state is ineligible", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, {
      FAKE_AUTO_MERGE_REQUEST: "{}",
      FAKE_MERGE_STATE: "DIRTY",
      FAKE_MERGEABLE: "MERGEABLE",
      FAKE_STATUS_CHECK_ROLLUP: '[{"name":"check","status":"IN_PROGRESS","conclusion":""}]',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "blocked");
    assert.equal(result.outputs.get("auto_merge_enabled"), "false");
    assert.match(result.outputs.get("reason") || "", /not eligible for auto-merge/);
    assert.doesNotMatch(result.log, /^pr merge /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge marks draft PRs ready before merging", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, {
      FAKE_IS_DRAFT: "true",
      FAKE_MERGE_STATE: "DRAFT",
      FAKE_MERGEABLE: "UNKNOWN",
      FAKE_READY_RECHECK: "true",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "merged");
    assert.equal((result.log.match(/^pr view /gm) || []).length, 2);
    assert.match(result.log, /^pr ready 42 --repo self-evolving\/repo$/m);
    assert.match(result.log, /^pr merge 42 --repo self-evolving\/repo --merge --match-head-commit abc123$/m);
    assert.ok(result.log.indexOf("pr ready 42") < result.log.indexOf("pr merge 42"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge does not constrain the configured PR base", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "merged");
    assert.doesNotMatch(result.log, /^pr list /m);
    assert.match(result.log, /^pr merge 42 --repo self-evolving\/repo --merge --match-head-commit abc123$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge blocks stale self-approval heads", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, { FAKE_APPROVAL_HEAD: "old123" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "blocked");
    assert.match(result.outputs.get("reason") || "", /different head SHA/);
    assert.doesNotMatch(result.log, /^pr merge /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
