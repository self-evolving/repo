import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  discussionArtifactPath,
  ensureMemoryStructure,
  issueArtifactPath,
  MEMORY_README,
  pullRequestArtifactPath,
  writeFileIfChanged,
} from "../memory-artifacts.js";

test("ensureMemoryStructure seeds README.md, PROJECT.md, MEMORY.md, and top-level dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "mem-artifacts-"));
  const first = ensureMemoryStructure(root, "owner/repo");
  assert.ok(existsSync(join(root, "README.md")));
  assert.ok(existsSync(join(root, "PROJECT.md")));
  assert.ok(existsSync(join(root, "MEMORY.md")));
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), MEMORY_README);
  assert.equal(readFileSync(join(root, "PROJECT.md"), "utf8"), "");
  assert.equal(readFileSync(join(root, "MEMORY.md"), "utf8"), "");
  assert.ok(existsSync(join(root, "daily")));
  assert.ok(existsSync(join(root, "github")));
  assert.ok(existsSync(join(root, "daily", ".gitkeep")));
  assert.ok(existsSync(join(root, "github", ".gitkeep")));
  assert.ok(first.createdFiles.length >= 4);

  // No per-type subdirectories — the flat layout encodes the type in the
  // filename (issue-<n>.json, pull-<n>.json, etc).
  assert.equal(existsSync(join(root, "github", "issues")), false);
  assert.equal(existsSync(join(root, "github", "pulls")), false);
  assert.equal(existsSync(join(root, "github", "discussions")), false);
  assert.equal(existsSync(join(root, "github", "commits")), false);

  const second = ensureMemoryStructure(root, "owner/repo");
  assert.deepEqual(second.createdFiles, []);
});

test("artifact paths are flat and type-prefixed", () => {
  assert.equal(issueArtifactPath("/m", 5), "/m/github/issue-5.json");
  assert.equal(pullRequestArtifactPath("/m", 7), "/m/github/pull-7.json");
  assert.equal(discussionArtifactPath("/m", 42), "/m/github/discussion-42.json");
});

test("issue, pull, and discussion numbers never collide even if they share a counter", () => {
  // Same number, different kind — these must live in separate files.
  const paths = [
    issueArtifactPath("/m", 42),
    pullRequestArtifactPath("/m", 42),
    discussionArtifactPath("/m", 42),
  ];
  assert.equal(new Set(paths).size, 3);
});

test("writeFileIfChanged only writes when content differs", () => {
  const root = mkdtempSync(join(tmpdir(), "mem-write-"));
  const path = join(root, "foo.json");
  assert.equal(writeFileIfChanged(path, "hello\n"), true);
  assert.equal(writeFileIfChanged(path, "hello\n"), false);
  assert.equal(writeFileIfChanged(path, "different\n"), true);
  assert.equal(readFileSync(path, "utf8"), "different\n");
});
