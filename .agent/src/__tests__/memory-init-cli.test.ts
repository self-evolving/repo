import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { runMemoryInitCli } from "../cli/memory/init.js";

function outputBuffer() {
  let text = "";
  return {
    write(chunk: string) { text += chunk; },
    read() { return text; },
  };
}

test("runMemoryInitCli seeds the default memory structure", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-init-"));
  const stdout = outputBuffer();
  const stderr = outputBuffer();

  const exitCode = runMemoryInitCli(
    ["--dir", root, "--repo", "self-evolving/repo"],
    { stdout, stderr },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.ok(existsSync(join(root, "README.md")));
  assert.ok(existsSync(join(root, "PROJECT.md")));
  assert.ok(existsSync(join(root, "MEMORY.md")));
  assert.ok(existsSync(join(root, "daily")));
  assert.ok(existsSync(join(root, "github")));
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /# Agent memory/);
  assert.equal(readFileSync(join(root, "PROJECT.md"), "utf8"), "");
  assert.equal(readFileSync(join(root, "MEMORY.md"), "utf8"), "");
  assert.match(stdout.read(), /"createdFiles"/);
});

test("runMemoryInitCli rejects a missing repo slug", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-init-missing-"));
  const stdout = outputBuffer();
  const stderr = outputBuffer();

  const exitCode = runMemoryInitCli(["--dir", root], {
    env: { MEMORY_DIR: root },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.read(), "");
  assert.match(stderr.read(), /Missing or invalid repository slug/);
});
