import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  parseGitHubRepoSlugFromRemoteUrl,
  runMemoryBootstrapBranchCli,
} from "../cli/memory/bootstrap-branch.js";

function outputBuffer() {
  let text = "";
  return {
    write(chunk: string) { text += chunk; },
    read() { return text; },
  };
}

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString("utf8").trim();
}

test("parseGitHubRepoSlugFromRemoteUrl handles ssh and https remotes", () => {
  assert.equal(
    parseGitHubRepoSlugFromRemoteUrl("git@github.com:self-evolving/repo.git"),
    "self-evolving/repo",
  );
  assert.equal(
    parseGitHubRepoSlugFromRemoteUrl("https://github.com/self-evolving/repo.git"),
    "self-evolving/repo",
  );
  assert.equal(parseGitHubRepoSlugFromRemoteUrl("/tmp/local-remote.git"), "");
});

test("runMemoryBootstrapBranchCli creates a local agent/memory branch", () => {
  const base = mkdtempSync(join(tmpdir(), "memory-bootstrap-"));
  const remoteDir = join(base, "remote.git");
  const workDir = join(base, "work");
  const stdout = outputBuffer();
  const stderr = outputBuffer();

  try {
    execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
    execFileSync("git", ["clone", remoteDir, workDir], { stdio: "pipe" });

    gitIn(workDir, ["config", "user.name", "test"]);
    gitIn(workDir, ["config", "user.email", "test@test.com"]);
    writeFileSync(join(workDir, "README.md"), "# Test repo\n", "utf8");
    gitIn(workDir, ["add", "README.md"]);
    gitIn(workDir, ["commit", "-m", "initial"]);

    const exitCode = runMemoryBootstrapBranchCli(
      ["--repo", "self-evolving/repo"],
      { cwd: workDir, stdout, stderr },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    assert.match(stdout.read(), /"branch": "agent\/memory"/);
    assert.match(stdout.read(), /"createdBranch": true/);
    assert.match(stdout.read(), /"nextStep": "git push origin agent\/memory"/);
    assert.notEqual(gitIn(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]), "agent/memory");
    assert.match(gitIn(workDir, ["show", "agent/memory:README.md"]), /# Agent memory/);
    assert.equal(gitIn(workDir, ["show", "agent/memory:PROJECT.md"]), "");
    assert.equal(gitIn(workDir, ["show", "agent/memory:MEMORY.md"]), "");
    assert.equal(gitIn(workDir, ["show", "agent/memory:daily/.gitkeep"]), "");
    assert.equal(gitIn(workDir, ["show", "agent/memory:github/.gitkeep"]), "");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runMemoryBootstrapBranchCli reuses an existing remote memory branch", () => {
  const base = mkdtempSync(join(tmpdir(), "memory-bootstrap-remote-"));
  const remoteDir = join(base, "remote.git");
  const seedDir = join(base, "seed");
  const workDir = join(base, "work");
  const stdout = outputBuffer();
  const stderr = outputBuffer();

  try {
    execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
    execFileSync("git", ["clone", remoteDir, seedDir], { stdio: "pipe" });

    gitIn(seedDir, ["config", "user.name", "test"]);
    gitIn(seedDir, ["config", "user.email", "test@test.com"]);
    writeFileSync(join(seedDir, "README.md"), "# Test repo\n", "utf8");
    gitIn(seedDir, ["add", "README.md"]);
    gitIn(seedDir, ["commit", "-m", "initial"]);
    gitIn(seedDir, ["push", "origin", "HEAD"]);

    gitIn(seedDir, ["checkout", "--orphan", "agent/memory"]);
    gitIn(seedDir, ["rm", "-rf", "."]);
    writeFileSync(join(seedDir, "NOTES.md"), "remote memory branch\n", "utf8");
    gitIn(seedDir, ["add", "NOTES.md"]);
    gitIn(seedDir, ["commit", "-m", "seed memory"]);
    gitIn(seedDir, ["push", "origin", "agent/memory"]);

    execFileSync("git", ["clone", remoteDir, workDir], { stdio: "pipe" });
    gitIn(workDir, ["config", "user.name", "test"]);
    gitIn(workDir, ["config", "user.email", "test@test.com"]);
    assert.equal(gitIn(workDir, ["branch", "--list", "agent/memory"]), "");
    assert.notEqual(gitIn(workDir, ["branch", "-r", "--list", "origin/agent/memory"]), "");

    const exitCode = runMemoryBootstrapBranchCli(
      ["--repo", "self-evolving/repo"],
      { cwd: workDir, stdout, stderr },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    assert.equal(gitIn(workDir, ["show", "agent/memory:NOTES.md"]), "remote memory branch");
    assert.match(gitIn(workDir, ["show", "agent/memory:README.md"]), /# Agent memory/);
    assert.equal(gitIn(workDir, ["show", "agent/memory:PROJECT.md"]), "");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runMemoryBootstrapBranchCli fails clearly when the target branch is already checked out", () => {
  const base = mkdtempSync(join(tmpdir(), "memory-bootstrap-current-branch-"));
  const repoDir = join(base, "repo");
  const stdout = outputBuffer();
  const stderr = outputBuffer();

  try {
    execFileSync("git", ["init", repoDir], { stdio: "pipe" });
    gitIn(repoDir, ["config", "user.name", "test"]);
    gitIn(repoDir, ["config", "user.email", "test@test.com"]);
    writeFileSync(join(repoDir, "README.md"), "# Test repo\n", "utf8");
    gitIn(repoDir, ["add", "README.md"]);
    gitIn(repoDir, ["commit", "-m", "initial"]);
    gitIn(repoDir, ["checkout", "-b", "agent/memory"]);

    const exitCode = runMemoryBootstrapBranchCli(
      ["--repo", "self-evolving/repo"],
      { cwd: repoDir, stdout, stderr },
    );

    assert.equal(exitCode, 1);
    assert.equal(stdout.read(), "");
    assert.match(stderr.read(), /already checked out in the current worktree/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
