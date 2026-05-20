import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { runPrepareLocalAgentContextCli } from "../cli/local/prepare-agent-context.js";

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

function writeAndCommit(dir: string, path: string, content: string, message: string): void {
  writeFileSync(join(dir, path), content, "utf8");
  gitIn(dir, ["add", path]);
  gitIn(dir, ["commit", "-m", message]);
}

function seedRepo(basePrefix: string): { base: string; remoteDir: string; workDir: string; seedDir: string } {
  const base = mkdtempSync(join(tmpdir(), basePrefix));
  const remoteDir = join(base, "remote.git");
  const seedDir = join(base, "seed");
  const workDir = join(base, "work");

  execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
  execFileSync("git", ["clone", remoteDir, seedDir], { stdio: "pipe" });
  gitIn(seedDir, ["config", "user.name", "test"]);
  gitIn(seedDir, ["config", "user.email", "test@test.com"]);
  writeAndCommit(seedDir, "README.md", "# Test repo\n", "initial");
  gitIn(seedDir, ["push", "origin", "HEAD"]);

  execFileSync("git", ["clone", remoteDir, workDir], { stdio: "pipe" });
  gitIn(workDir, ["config", "user.name", "test"]);
  gitIn(workDir, ["config", "user.email", "test@test.com"]);

  return { base, remoteDir, workDir, seedDir };
}

function seedBranch(dir: string, branch: string, files: Record<string, string>): void {
  const previousBranch = gitIn(dir, ["branch", "--show-current"]);
  gitIn(dir, ["checkout", "--orphan", branch]);
  gitIn(dir, ["rm", "-rf", "."]);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content, "utf8");
    gitIn(dir, ["add", path]);
  }
  gitIn(dir, ["commit", "-m", `seed ${branch}`]);
  gitIn(dir, ["push", "origin", branch]);
  gitIn(dir, ["checkout", previousBranch]);
}

test("runPrepareLocalAgentContextCli clones memory and rubrics into ignored local context", () => {
  const { base, workDir, seedDir } = seedRepo("prepare-local-agent-");
  const stdout = outputBuffer();
  const stderr = outputBuffer();

  try {
    seedBranch(seedDir, "agent/memory", {
      "PROJECT.md": "Project context\n",
      "MEMORY.md": "Durable memory\n",
    });
    seedBranch(seedDir, "agent/rubrics", {
      "README.md": "# Rubrics\n",
    });
    gitIn(workDir, ["fetch", "origin"]);

    const exitCode = runPrepareLocalAgentContextCli(
      ["--repo", "self-evolving/repo"],
      { cwd: workDir, stdout, stderr },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    assert.ok(existsSync(join(workDir, ".agent", "local", "memory", "PROJECT.md")));
    assert.ok(existsSync(join(workDir, ".agent", "local", "rubrics", "README.md")));

    const context = readFileSync(join(workDir, ".agent", "local", "AGENT_CONTEXT.md"), "utf8");
    assert.match(context, /export MEMORY_DIR="\.agent\/local\/memory"/);
    assert.match(context, /export RUBRICS_DIR="\.agent\/local\/rubrics"/);
    assert.match(context, /launch a separate review\/checking sub-agent/);
    assert.match(stdout.read(), /"available": true/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runPrepareLocalAgentContextCli treats missing rubrics branch as non-fatal", () => {
  const { base, workDir, seedDir } = seedRepo("prepare-local-agent-missing-");
  const stdout = outputBuffer();
  const stderr = outputBuffer();

  try {
    seedBranch(seedDir, "agent/memory", {
      "PROJECT.md": "Project context\n",
    });
    gitIn(workDir, ["fetch", "origin"]);

    const exitCode = runPrepareLocalAgentContextCli(
      ["--repo", "self-evolving/repo"],
      { cwd: workDir, stdout, stderr },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    assert.ok(existsSync(join(workDir, ".agent", "local", "memory", "PROJECT.md")));
    assert.ok(!existsSync(join(workDir, ".agent", "local", "rubrics")));

    const context = readFileSync(join(workDir, ".agent", "local", "AGENT_CONTEXT.md"), "utf8");
    assert.match(context, /rubrics: unavailable/);
    assert.match(context, /Agent \/ Rubrics \/ Initialization/);
    assert.match(stdout.read(), /"available": false/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runPrepareLocalAgentContextCli removes stale checkout when ref becomes unavailable", () => {
  const { base, workDir, seedDir } = seedRepo("prepare-local-agent-stale-");

  try {
    seedBranch(seedDir, "agent/memory", {
      "PROJECT.md": "Project context\n",
    });
    seedBranch(seedDir, "agent/rubrics", {
      "README.md": "# Rubrics\n",
    });
    gitIn(workDir, ["fetch", "origin"]);

    const firstStdout = outputBuffer();
    const firstStderr = outputBuffer();
    const firstExitCode = runPrepareLocalAgentContextCli(
      ["--repo", "self-evolving/repo"],
      { cwd: workDir, stdout: firstStdout, stderr: firstStderr },
    );

    assert.equal(firstExitCode, 0);
    assert.equal(firstStderr.read(), "");
    assert.ok(existsSync(join(workDir, ".agent", "local", "rubrics", "README.md")));

    const secondStdout = outputBuffer();
    const secondStderr = outputBuffer();
    const secondExitCode = runPrepareLocalAgentContextCli(
      ["--repo", "self-evolving/repo", "--rubrics-ref", "agent/missing-rubrics"],
      { cwd: workDir, stdout: secondStdout, stderr: secondStderr },
    );

    assert.equal(secondExitCode, 0);
    assert.equal(secondStderr.read(), "");
    assert.ok(!existsSync(join(workDir, ".agent", "local", "rubrics")));
    assert.ok(existsSync(join(workDir, ".agent", "local", "memory", "PROJECT.md")));

    const context = readFileSync(join(workDir, ".agent", "local", "AGENT_CONTEXT.md"), "utf8");
    assert.match(context, /rubrics: unavailable/);
    assert.match(context, /agent\/missing-rubrics/);
    assert.match(secondStdout.read(), /"available": false/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
