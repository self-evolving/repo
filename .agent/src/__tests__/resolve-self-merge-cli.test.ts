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

function writeFakeGh(tempDir: string): string {
  const logPath = join(tempDir, "gh.log");
  writeFileSync(join(tempDir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"baseRefName":"%s","headRefName":"%s","headRefOid":"abc123","isCrossRepository":%s,"isDraft":%s,"state":"%s","mergeStateStatus":"%s","mergeable":"%s","reviewDecision":"%s","statusCheckRollup":%s,"autoMergeRequest":null}\\n' \
    "\${FAKE_BASE_REF-main}" \
    "\${FAKE_HEAD_REF-agent/self-merge}" \
    "\${FAKE_IS_CROSS_REPO-false}" \
    "\${FAKE_IS_DRAFT-false}" \
    "\${FAKE_PR_STATE-OPEN}" \
    "\${FAKE_MERGE_STATE-CLEAN}" \
    "\${FAKE_MERGEABLE-MERGEABLE}" \
    "\${FAKE_REVIEW_DECISION-APPROVED}" \
    "\${FAKE_STATUS_CHECK_ROLLUP-[]}"
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
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' "\${FAKE_PR_LIST-[]}"
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
  return logPath;
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
      DEFAULT_BRANCH: "main",
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
    assert.equal(result.outputs.get("status_post"), "false");
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

test("resolve-self-merge marks trusted draft agent PRs ready before merging", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, { FAKE_IS_DRAFT: "true" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "merged");
    assert.match(result.log, /^pr ready 42 --repo self-evolving\/repo$/m);
    assert.match(result.log, /^pr merge 42 --repo self-evolving\/repo --merge --match-head-commit abc123$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge blocks untrusted draft PRs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, {
      FAKE_HEAD_REF: "feature/self-merge",
      FAKE_IS_DRAFT: "true",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "blocked");
    assert.match(result.outputs.get("reason") || "", /trusted agent branch/);
    assert.doesNotMatch(result.log, /^pr ready /m);
    assert.doesNotMatch(result.log, /^pr merge /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge blocks fork heads", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, { FAKE_IS_CROSS_REPO: "true" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "blocked");
    assert.match(result.outputs.get("reason") || "", /fork/);
    assert.doesNotMatch(result.log, /^pr merge /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge merges into open same-repo stack bases", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, {
      FAKE_BASE_REF: "agent/parent",
      FAKE_PR_LIST: '[{"number":186,"headRefName":"agent/parent","isCrossRepository":false}]',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "merged");
    assert.equal(result.outputs.get("status_post"), "false");
    assert.match(result.log, /^pr list --repo self-evolving\/repo --state open --head agent\/parent --json number,headRefName,isCrossRepository$/m);
    assert.match(result.log, /^pr merge 42 --repo self-evolving\/repo --merge --match-head-commit abc123$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-merge blocks unknown non-default bases", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-merge-cli-"));
  try {
    writeFakeGh(tempDir);

    const result = runResolveSelfMerge(tempDir, { FAKE_BASE_REF: "agent/parent" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.get("conclusion"), "blocked");
    assert.equal(result.outputs.get("status_post"), "true");
    assert.match(result.outputs.get("reason") || "", /open same-repo stack base/);
    assert.doesNotMatch(result.log, /^pr merge /m);
    const body = readFileSync(result.outputs.get("body_file") || "", "utf8");
    assert.match(body, /<!-- sepo-agent-self-merge -->/);
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
