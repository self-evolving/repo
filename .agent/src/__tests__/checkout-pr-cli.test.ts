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

interface CheckoutFixture {
  binDir: string;
  headOid: string;
  homeDir: string;
  remote: string;
  tempDir: string;
  workspace: string;
}

function createCheckoutFixture(branchName: string, setupBranch: (seed: string) => void): CheckoutFixture {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-checkout-pr-"));
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
  writeFileSync(join(seed, ".gitignore"), ".agent/dist/\n", "utf8");
  git(seed, ["add", "README.md", ".gitignore"]);
  git(seed, ["commit", "-m", "initial"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);

  git(seed, ["checkout", "-b", branchName]);
  setupBranch(seed);
  git(seed, ["push", "origin", branchName]);
  const headOid = git(seed, ["rev-parse", "HEAD"]);

  git(tempDir, ["clone", remote, workspace]);
  git(workspace, ["checkout", "main"]);

  const fakeGh = join(binDir, "gh");
  writeExecutable(fakeGh, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"$1\" == \"pr\" && \"$2\" == \"view\" ]]; then",
    `  printf '%s\\n' ${JSON.stringify(JSON.stringify({
      headRefName: branchName,
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

  return { binDir, headOid, homeDir, remote, tempDir, workspace };
}

function seedBuiltRuntime(workspace: string): string {
  const runtimeCli = join(workspace, ".agent", "dist", "cli", "post-response.js");
  mkdirSync(join(workspace, ".agent", "dist", "cli"), { recursive: true });
  writeFileSync(runtimeCli, "console.log('runtime ok');\n", "utf8");
  return runtimeCli;
}

function runCheckoutPr(fixture: CheckoutFixture): void {
  execFileSync("node", [".agent/dist/cli/checkout-pr.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIT_ALLOW_PROTOCOL: "file:https",
      GITHUB_REPOSITORY: "self-evolving/repo",
      GITHUB_WORKSPACE: fixture.workspace,
      GH_TOKEN: "token",
      HOME: fixture.homeDir,
      PATH: `${fixture.binDir}:${process.env.PATH || ""}`,
      PR_NUMBER: "20",
    },
    stdio: "pipe",
  });
}

test("checkout-pr force-checks out branches that accidentally track generated agent dist", () => {
  const fixture = createCheckoutFixture("feature/generated-dist", (seed) => {
    mkdirSync(join(seed, ".agent", "dist"), { recursive: true });
    writeFileSync(join(seed, ".agent", "dist", "generated.js"), "tracked from pr\n", "utf8");
    git(seed, ["add", "-f", ".agent/dist/generated.js"]);
    git(seed, ["commit", "-m", "track generated dist"]);
  });

  try {
    mkdirSync(join(fixture.workspace, ".agent", "dist"), { recursive: true });
    writeFileSync(join(fixture.workspace, ".agent", "dist", "generated.js"), "untracked build output\n", "utf8");

    runCheckoutPr(fixture);

    assert.equal(git(fixture.workspace, ["branch", "--show-current"]), "feature/generated-dist");
    assert.equal(
      readFileSync(join(fixture.workspace, ".agent", "dist", "generated.js"), "utf8"),
      "tracked from pr\n",
    );
    assert.equal(git(fixture.workspace, ["status", "--short"]), "");
  } finally {
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("checkout-pr preserves built runtime when the PR branch does not track agent dist", () => {
  const fixture = createCheckoutFixture("feature/no-generated-dist", (seed) => {
    writeFileSync(join(seed, "README.md"), "feature\n", "utf8");
    git(seed, ["add", "README.md"]);
    git(seed, ["commit", "-m", "update readme"]);
  });

  try {
    const runtimeCli = seedBuiltRuntime(fixture.workspace);

    runCheckoutPr(fixture);

    assert.equal(git(fixture.workspace, ["branch", "--show-current"]), "feature/no-generated-dist");
    assert.equal(readFileSync(join(fixture.workspace, "README.md"), "utf8"), "feature\n");
    assert.equal(execFileSync("node", [runtimeCli], { cwd: fixture.workspace }).toString("utf8"), "runtime ok\n");
    assert.equal(git(fixture.workspace, ["status", "--short"]), "");
  } finally {
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});
