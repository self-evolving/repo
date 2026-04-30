import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveImplementationBase, validateBaseBranch } from "../implementation-base.js";

test("implementation base defaults to repository default branch", () => {
  assert.deepEqual(resolveImplementationBase({ defaultBranch: "main" }), {
    baseBranch: "main",
    source: "default_branch",
  });
});

test("implementation base accepts an explicit branch", () => {
  assert.deepEqual(resolveImplementationBase({
    defaultBranch: "main",
    baseBranch: "agent/implement-issue-30/codex-1",
  }), {
    baseBranch: "agent/implement-issue-30/codex-1",
    source: "base_branch",
  });
});

test("implementation base resolves an open same-repository PR head", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-implementation-base-"));
  const originalPath = process.env.PATH;

  writeFileSync(join(tempDir, "gh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [ \"${1-}\" = \"pr\" ] && [ \"${2-}\" = \"view\" ]; then",
    "  printf '%s\\n' '{\"headRefName\":\"agent/parent-branch\",\"headRefOid\":\"abc123\",\"isCrossRepository\":false,\"state\":\"OPEN\"}'",
    "  exit 0",
    "fi",
    "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o755 });

  process.env.PATH = `${tempDir}:${originalPath || ""}`;

  try {
    assert.deepEqual(resolveImplementationBase({
      defaultBranch: "main",
      basePr: "42",
      repo: "self-evolving/repo",
    }), {
      baseBranch: "agent/parent-branch",
      source: "base_pr",
      basePr: 42,
    });
  } finally {
    process.env.PATH = originalPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("implementation base rejects ambiguous and unsafe inputs", () => {
  assert.throws(
    () => resolveImplementationBase({ defaultBranch: "main", baseBranch: "topic", basePr: "12" }),
    /set only one/,
  );
  assert.throws(
    () => resolveImplementationBase({ defaultBranch: "main", basePr: "#12" }),
    /positive integer/,
  );
  assert.throws(() => validateBaseBranch("bad branch"), /invalid base branch/);
  assert.throws(() => validateBaseBranch("-topic"), /must not start/);
});
