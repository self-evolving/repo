import { execFileSync, spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { runVerification, shouldRunVerification } from "../verify.js";

const repoRoot = resolve(__dirname, "../../..");

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

test("runVerification validates add-rubrics worktree rubric schemas", () => {
  const repo = mkdtempSync(join(tmpdir(), "add-rubrics-verify-"));
  const previousRuntimeDir = process.env.AGENT_RUNTIME_DIR;
  try {
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "Test User"]);
    git(repo, ["config", "user.email", "test@example.com"]);

    mkdirSync(join(repo, "rubrics", "coding"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "rubrics\n", "utf8");
    writeFileSync(
      join(repo, "rubrics", "coding", "bad-weight.yaml"),
      [
        "id: bad-weight",
        "title: Bad weight",
        "description: Invalid rubric weights must block proposals.",
        "applies_to: [implement]",
        "weight: 99",
        "",
      ].join("\n"),
      "utf8",
    );

    process.env.AGENT_RUNTIME_DIR = repoRoot;
    const result = runVerification(repo, { route: "add-rubrics" });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.output, /rubrics\/coding\/bad-weight\.yaml/);
    assert.match(result.output, /weight must be an integer from 1 to 10/);
  } finally {
    if (previousRuntimeDir === undefined) {
      delete process.env.AGENT_RUNTIME_DIR;
    } else {
      process.env.AGENT_RUNTIME_DIR = previousRuntimeDir;
    }
    rmSync(repo, { recursive: true, force: true });
  }
});
