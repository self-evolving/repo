import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { type CommandRunner, publishRelease } from "../release-publish.js";

const TARGET_SHA = "0123456789abcdef0123456789abcdef01234567";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  tagExists = false;
  releaseExists = false;
  releaseCreated = false;
  releaseUpdated = false;

  run(command: string, args: string[]): string {
    this.calls.push({ command, args });
    if (command === "git" && args.join(" ") === "rev-parse HEAD") {
      return `${TARGET_SHA}\n`;
    }
    if (command !== "gh") {
      throw new Error(`unexpected command: ${command}`);
    }

    const text = args.join(" ");
    if (text.includes("/git/ref/tags/")) {
      if (!this.tagExists) throw new Error("missing tag");
      return "refs/tags/v0.1.0\n";
    }
    if (text.includes("/git/tags")) {
      return "89abcdef0123456789abcdef0123456789abcdef\n";
    }
    if (text.includes("/git/refs")) {
      this.tagExists = true;
      return "{}\n";
    }
    if (args[0] === "release" && args[1] === "view") {
      if (!this.releaseExists && !this.releaseCreated && !this.releaseUpdated) {
        throw new Error("missing release");
      }
      return "https://github.com/self-evolving/repo/releases/tag/v0.1.0\n";
    }
    if (args[0] === "release" && args[1] === "create") {
      this.releaseCreated = true;
      return "";
    }
    if (args[0] === "release" && args[1] === "edit") {
      this.releaseUpdated = true;
      return "";
    }
    throw new Error(`unexpected gh args: ${text}`);
  }
}

function withPackage(version: string, callback: (cwd: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), "sepo-release-publish-"));
  try {
    mkdirSync(join(tempDir, ".agent"));
    writeFileSync(
      join(tempDir, ".agent", "package.json"),
      JSON.stringify({ name: "@self-evolving/sepo", version }),
      "utf8",
    );
    callback(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("publishRelease creates missing annotated tag and draft prerelease", () => {
  withPackage("0.1.0", (cwd) => {
    const runner = new FakeRunner();
    const result = publishRelease({
      repo: "self-evolving/repo",
      version: "0.1.0",
      targetRef: "main",
      draft: "true",
      prerelease: "auto",
      updateExisting: "false",
      cwd,
      runner,
    });

    assert.equal(result.tag, "v0.1.0");
    assert.equal(result.targetSha, TARGET_SHA);
    assert.equal(result.prerelease, true);
    assert.equal(result.tagCreated, true);
    assert.equal(result.releaseAction, "created");
    const createCall = runner.calls.find((call) => call.args[0] === "release" && call.args[1] === "create");
    assert.ok(createCall);
    assert.ok(createCall.args.includes("--draft"));
    assert.ok(createCall.args.includes("--prerelease"));
  });
});

test("publishRelease fails when release exists without update_existing", () => {
  withPackage("0.1.0", (cwd) => {
    const runner = new FakeRunner();
    runner.tagExists = true;
    runner.releaseExists = true;

    assert.throws(
      () => publishRelease({
        repo: "self-evolving/repo",
        version: "0.1.0",
        targetRef: "main",
        draft: "true",
        prerelease: "auto",
        updateExisting: "false",
        cwd,
        runner,
      }),
      /already exists/,
    );
  });
});

test("publishRelease rejects package version mismatches", () => {
  withPackage("0.1.0", (cwd) => {
    const runner = new FakeRunner();
    assert.throws(
      () => publishRelease({
        repo: "self-evolving/repo",
        version: "0.2.0",
        targetRef: "main",
        draft: "true",
        prerelease: "auto",
        updateExisting: "false",
        cwd,
        runner,
      }),
      /does not match 0\.2\.0/,
    );
    assert.equal(runner.calls.length, 0);
  });
});
