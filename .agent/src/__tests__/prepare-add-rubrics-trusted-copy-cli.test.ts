import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function runCli(sourceDir: string, trustedDir: string) {
  return spawnSync("node", [".agent/dist/cli/prepare-add-rubrics-trusted-copy.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RUBRICS_SOURCE_DIR: sourceDir,
      TRUSTED_RUBRICS_DIR: trustedDir,
    },
    encoding: "utf8",
  });
}

test("prepare add-rubrics trusted copy preserves allowed proposal files", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-trusted-copy-"));

  try {
    const sourceDir = join(tempDir, "source");
    const trustedDir = join(tempDir, "trusted");

    writeFile(join(sourceDir, "rubrics/coding/concise.yml"), "id: concise\n");
    writeFile(join(sourceDir, "rubrics/workflow/review.yaml"), "id: review\n");
    writeFile(join(sourceDir, "rubrics/coding/.gitkeep"), "");
    writeFile(join(sourceDir, "rubrics/communication/.gitkeep"), "");
    writeFile(join(sourceDir, "README.md"), "# Rubrics\n");
    writeFile(join(sourceDir, "NOT_COPIED.md"), "ignored\n");
    writeFile(join(trustedDir, "rubrics/old.yml"), "id: old\n");
    writeFile(join(trustedDir, "README.md"), "# Old\n");

    const result = runCli(sourceDir, trustedDir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(trustedDir, "rubrics/coding/concise.yml"), "utf8"), "id: concise\n");
    assert.equal(readFileSync(join(trustedDir, "rubrics/workflow/review.yaml"), "utf8"), "id: review\n");
    assert.equal(readFileSync(join(trustedDir, "rubrics/coding/.gitkeep"), "utf8"), "");
    assert.equal(readFileSync(join(trustedDir, "rubrics/communication/.gitkeep"), "utf8"), "");
    assert.equal(readFileSync(join(trustedDir, "README.md"), "utf8"), "# Rubrics\n");
    assert.equal(existsSync(join(trustedDir, "rubrics/old.yml")), false);
    assert.equal(existsSync(join(trustedDir, "NOT_COPIED.md")), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepare add-rubrics trusted copy rejects symlinks under rubrics", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-trusted-copy-"));

  try {
    const sourceDir = join(tempDir, "source");
    const trustedDir = join(tempDir, "trusted");
    const target = join(tempDir, "outside.yml");
    writeFile(target, "id: outside\n");
    mkdirSync(join(sourceDir, "rubrics/coding"), { recursive: true });
    symlinkSync(target, join(sourceDir, "rubrics/coding/link.yml"));

    const result = runCli(sourceDir, trustedDir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unexpected symlink under rubrics\//);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepare add-rubrics trusted copy rejects symlinked top-level README", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-trusted-copy-"));

  try {
    const sourceDir = join(tempDir, "source");
    const trustedDir = join(tempDir, "trusted");
    const target = join(tempDir, "README-target.md");
    writeFile(join(sourceDir, "rubrics/coding/concise.yml"), "id: concise\n");
    writeFile(target, "# Linked\n");
    symlinkSync(target, join(sourceDir, "README.md"));

    const result = runCli(sourceDir, trustedDir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Top-level README\.md must not be a symlink/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepare add-rubrics trusted copy rejects unexpected files under rubrics", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-trusted-copy-"));

  try {
    const sourceDir = join(tempDir, "source");
    const trustedDir = join(tempDir, "trusted");
    writeFile(join(sourceDir, "rubrics/coding/notes.txt"), "not yaml\n");

    const result = runCli(sourceDir, trustedDir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Only rubrics\/\*\*\/\*\.yml, rubrics\/\*\*\/\*\.yaml, rubrics\/\*\*\/\.gitkeep, and top-level README\.md may be committed/);
    assert.match(result.stderr, /notes\.txt/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
