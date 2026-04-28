import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "pipe",
  }).toString("utf8").trim();
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755 });
}

test("checkout-pr removes generated agent dist before switching to the PR branch", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-checkout-pr-"));

  try {
    const remote = join(tempDir, "remote.git");
    const seed = join(tempDir, "seed");
    const workspace = join(tempDir, "workspace");
    const binDir = join(tempDir, "bin");
    const homeDir = join(tempDir, "home");
    mkdirSync(seed, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    git(tempDir, ["init", "--bare", remote]);
    git(seed, ["init"]);
    git(seed, ["config", "user.name", "Test User"]);
    git(seed, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(seed, "README.md"), "main\n", "utf8");
    git(seed, ["add", "README.md"]);
    git(seed, ["commit", "-m", "initial"]);
    git(seed, ["branch", "-M", "main"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);

    git(seed, ["checkout", "-b", "feature/generated-dist"]);
    mkdirSync(join(seed, ".agent", "dist"), { recursive: true });
    writeFileSync(join(seed, ".agent", "dist", "generated.js"), "tracked from pr\n", "utf8");
    git(seed, ["add", ".agent/dist/generated.js"]);
    git(seed, ["commit", "-m", "track generated dist"]);
    git(seed, ["push", "origin", "feature/generated-dist"]);
    const headOid = git(seed, ["rev-parse", "HEAD"]);

    git(tempDir, ["clone", remote, workspace]);
    git(workspace, ["checkout", "main"]);
    mkdirSync(join(workspace, ".agent", "dist"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "dist", "generated.js"), "untracked build output\n", "utf8");

    const fakeGh = join(binDir, "gh");
    writeExecutable(fakeGh, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"$1\" == \"pr\" && \"$2\" == \"view\" ]]; then",
      `  printf '%s\\n' ${JSON.stringify(JSON.stringify({
        headRefName: "feature/generated-dist",
        headRefOid: headOid,
        isCrossRepository: false,
        state: "OPEN",
      }))}`,
      "  exit 0",
      "fi",
      "echo unexpected gh invocation: $* >&2",
      "exit 1",
      "",
    ].join("\n"));

    execFileSync("git", [
      "config",
      "--global",
      `url.file://${remote}.insteadOf`,
      "https://x-access-token:token@github.com/self-evolving/repo.git",
    ], { env: { ...process.env, HOME: homeDir }, stdio: "pipe" });

    execFileSync("node", [".agent/dist/cli/checkout-pr.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_ALLOW_PROTOCOL: "file:https",
        GITHUB_REPOSITORY: "self-evolving/repo",
        GITHUB_WORKSPACE: workspace,
        GH_TOKEN: "token",
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        PR_NUMBER: "20",
      },
      stdio: "pipe",
    });

    assert.equal(git(workspace, ["branch", "--show-current"]), "feature/generated-dist");
    assert.equal(readFileSync(join(workspace, ".agent", "dist", "generated.js"), "utf8"), "tracked from pr\n");
    assert.equal(git(workspace, ["status", "--short"]), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
