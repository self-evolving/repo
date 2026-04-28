import { execFileSync, spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { shouldRunVerification } from "../verify.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString("utf8").trim();
}

function runVerifier(cwd: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [".agent/scripts/post-agent-verify.sh"], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("shouldRunVerification skips unchanged clean runs", () => {
  assert.equal(shouldRunVerification(false, false), false);
});

test("shouldRunVerification runs for dirty worktrees", () => {
  assert.equal(shouldRunVerification(true, false), true);
});

test("shouldRunVerification runs for clean branch head updates", () => {
  assert.equal(shouldRunVerification(false, true), true);
});

test("post-agent-verify uses VERIFY_BASE_SHA for clean history-only workflow changes", () => {
  const repo = mkdtempSync(join(tmpdir(), "post-agent-verify-"));
  try {
    mkdirSync(join(repo, ".agent", "scripts"), { recursive: true });
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    cpSync(
      join(process.cwd(), "scripts", "post-agent-verify.sh"),
      join(repo, ".agent", "scripts", "post-agent-verify.sh"),
    );

    git(repo, ["init"]);
    git(repo, ["config", "user.name", "Test User"]);
    git(repo, ["config", "user.email", "test@example.com"]);

    writeFileSync(
      join(repo, ".github", "workflows", "ci.yml"),
      [
        "name: CI",
        "on: workflow_dispatch",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo ok",
        "",
      ].join("\n"),
      "utf8",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "seed workflow"]);
    const baseSha = git(repo, ["rev-parse", "HEAD"]);

    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: [unterminated\n", "utf8");
    git(repo, ["add", ".github/workflows/ci.yml"]);
    git(repo, ["commit", "-m", "break workflow yaml"]);
    assert.equal(git(repo, ["status", "--porcelain"]), "");

    const result = runVerifier(repo, { VERIFY_BASE_SHA: baseSha });
    assert.notEqual(
      result.status,
      0,
      `history-aware verification should inspect changed workflow files\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
