import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  type CommandRunner,
  DEFAULT_INSTALL_BRANCH,
  prepareInstallForkPr,
  publishInstallForkPr,
} from "../install-fork-pr.js";

function repoRecord(fullName: string, opts: {
  private?: boolean;
  fork?: boolean;
  parent?: string;
  defaultBranch?: string;
} = {}): Record<string, unknown> {
  const [owner, name] = fullName.split("/");
  return {
    full_name: fullName,
    name,
    owner: { login: owner },
    private: Boolean(opts.private),
    fork: Boolean(opts.fork),
    parent: opts.parent ? { full_name: opts.parent } : undefined,
    source: opts.parent ? { full_name: opts.parent } : undefined,
    default_branch: opts.defaultBranch || "main",
  };
}

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ tool: "gh" | "git"; args: string[]; cwd?: string }> = [];
  readonly repos = new Map<string, Record<string, unknown>>();
  prs: Array<Record<string, unknown>> = [];
  createdPrUrl = "https://github.com/lm4sci/lm4sci.github.io/pull/77";
  failPush = false;

  constructor(readonly login = "sepo-install-bot") {}

  gh(args: string[]): string {
    this.calls.push({ tool: "gh", args: [...args] });

    if (args[0] === "api" && args[1] === "user") {
      return `${this.login}\n`;
    }

    if (args[0] === "api" && args[1]?.startsWith("repos/")) {
      const slug = args[1].replace(/^repos\//, "");
      const repo = this.repos.get(slug);
      if (!repo) throw new Error(`missing repo ${slug}`);
      return JSON.stringify(repo);
    }

    if (args[0] === "api" && args[1] === "--method" && args[2] === "POST" && args[3]?.endsWith("/forks")) {
      const target = args[3].replace(/^repos\//, "").replace(/\/forks$/, "");
      const targetRepo = this.repos.get(target);
      if (!targetRepo) throw new Error(`missing target ${target}`);
      const name = String(targetRepo.name);
      const fork = repoRecord(`${this.login}/${name}`, { fork: true, parent: target });
      this.repos.set(`${this.login}/${name}`, fork);
      return JSON.stringify(fork);
    }

    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify(this.prs);
    }

    if (args[0] === "pr" && args[1] === "create") {
      return `${this.createdPrUrl}\n`;
    }

    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  }

  git(args: string[], cwd: string): string {
    this.calls.push({ tool: "git", args: [...args], cwd });
    if (this.failPush && args[0] === "push") throw new Error("push failed");
    return "";
  }

  sleep(): void {
    this.calls.push({ tool: "gh", args: ["sleep"] });
  }

  called(tool: "gh" | "git", pattern: RegExp): boolean {
    return this.calls.some((call) => call.tool === tool && pattern.test(call.args.join(" ")));
  }
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  }).toString("utf8").trim();
}

function configureGitUser(workdir: string): void {
  runGit(["config", "user.name", "Sepo Test"], workdir);
  runGit(["config", "user.email", "sepo-test@example.com"], workdir);
}

function commitFile(workdir: string, path: string, contents: string, message: string): void {
  writeFileSync(join(workdir, path), contents, "utf8");
  runGit(["add", path], workdir);
  runGit(["commit", "-m", message], workdir);
}

class GitFixtureRunner extends FakeRunner {
  constructor(readonly remotes: Map<string, string>, login = "sepo-install-bot") {
    super(login);
  }

  override git(args: string[], cwd: string): string {
    this.calls.push({ tool: "git", args: [...args], cwd });
    return runGit(args.map((arg) => this.rewriteRemote(arg)), cwd);
  }

  private rewriteRemote(value: string): string {
    const match = value.match(/^https:\/\/(?:x-access-token:[^@]+@)?github\.com\/(.+?)\.git$/);
    if (!match) return value;
    return this.remotes.get(match[1]) || value;
  }
}

function createGitFixture(root: string): { targetBare: string; forkBare: string } {
  const targetWork = join(root, "target-work");
  const targetBare = join(root, "target.git");
  const forkBare = join(root, "fork.git");
  const forkWork = join(root, "fork-work");

  mkdirSync(targetWork);
  runGit(["init", "-b", "main"], targetWork);
  configureGitUser(targetWork);
  commitFile(targetWork, "README.md", "target\n", "Initial target");
  runGit(["clone", "--bare", targetWork, targetBare], root);
  runGit(["clone", "--bare", targetBare, forkBare], root);

  runGit(["clone", forkBare, forkWork], root);
  configureGitUser(forkWork);
  runGit(["checkout", "-b", DEFAULT_INSTALL_BRANCH], forkWork);
  commitFile(forkWork, "agent.txt", "old install\n", "Existing install");
  runGit(["push", "origin", DEFAULT_INSTALL_BRANCH], forkWork);

  return { targetBare, forkBare };
}

test("prepareInstallForkPr creates a fork and target checkout for public installs", () => {
  const runner = new FakeRunner();
  runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));

  const result = prepareInstallForkPr({
    targetRepo: "lm4sci/lm4sci.github.io",
    githubToken: "pat-token",
    workdir: "/tmp/lm4sci-install",
    forkPollAttempts: 1,
    runner,
  });

  assert.equal(result.status, "prepared");
  assert.equal(result.targetRepo, "lm4sci/lm4sci.github.io");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.branch, DEFAULT_INSTALL_BRANCH);
  assert.equal(result.tokenOwner, "sepo-install-bot");
  assert.equal(result.forkRepo, "sepo-install-bot/lm4sci.github.io");
  assert.equal(result.workdir, "/tmp/lm4sci-install");
  assert.equal(result.reusedPr, false);
  assert.ok(runner.called("gh", /api --method POST repos\/lm4sci\/lm4sci\.github\.io\/forks/));
  assert.ok(runner.called("git", /clone --depth 1 --branch main https:\/\/github\.com\/lm4sci\/lm4sci\.github\.io\.git/));
  assert.ok(runner.called("git", /checkout -B agent\/install-agent-infra/));
});

test("prepareInstallForkPr reuses a same-owner install PR at prepare time", () => {
  const runner = new FakeRunner("lm4sci");
  runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
  runner.prs = [{
    number: 55,
    url: "https://github.com/lm4sci/lm4sci.github.io/pull/55",
    headRefName: DEFAULT_INSTALL_BRANCH,
    headRepositoryOwner: { login: "lm4sci" },
  }];

  const result = prepareInstallForkPr({
    targetRepo: "lm4sci/lm4sci.github.io",
    githubToken: "pat-token",
    workdir: "/tmp/lm4sci-install-reuse",
    runner,
  });

  assert.equal(result.status, "prepared");
  assert.equal(result.forkRepo, "lm4sci/lm4sci.github.io");
  assert.equal(result.reusedPr, true);
  assert.equal(result.prUrl, "https://github.com/lm4sci/lm4sci.github.io/pull/55");
  assert.equal(result.prNumber, "55");
  assert.equal(runner.called("gh", /forks/), false);
  assert.ok(runner.called("git", /fetch --depth 1 install-fork agent\/install-agent-infra/));
  assert.ok(runner.called("git", /checkout -B agent\/install-agent-infra FETCH_HEAD/));
});

test("prepareInstallForkPr blocks non-public targets before fork or clone", () => {
  const runner = new FakeRunner();
  runner.repos.set("private-org/private-repo", repoRecord("private-org/private-repo", { private: true }));

  const result = prepareInstallForkPr({
    targetRepo: "private-org/private-repo",
    githubToken: "pat-token",
    runner,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.blockedCode, "target_not_public");
  assert.equal(runner.called("gh", /forks/), false);
  assert.equal(runner.called("git", /clone/), false);
});

test("prepareInstallForkPr blocks duplicate install PRs from another owner", () => {
  const runner = new FakeRunner();
  runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
  runner.prs = [{
    number: 12,
    url: "https://github.com/lm4sci/lm4sci.github.io/pull/12",
    headRefName: DEFAULT_INSTALL_BRANCH,
    headRepositoryOwner: { login: "other-bot" },
  }];

  const result = prepareInstallForkPr({
    targetRepo: "lm4sci/lm4sci.github.io",
    githubToken: "pat-token",
    runner,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.blockedCode, "duplicate_install_pr");
  assert.match(result.message, /other-bot:agent\/install-agent-infra/);
  assert.equal(runner.called("gh", /forks/), false);
});

test("publishInstallForkPr pushes and reuses an existing install PR from the token owner", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "install-fork-pr-"));
  const bodyFile = join(tempDir, "body.md");
  writeFileSync(bodyFile, "Install Sepo.\n", "utf8");

  try {
    const runner = new FakeRunner();
    runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
    runner.repos.set(
      "sepo-install-bot/lm4sci.github.io",
      repoRecord("sepo-install-bot/lm4sci.github.io", {
        fork: true,
        parent: "lm4sci/lm4sci.github.io",
      }),
    );
    runner.prs = [{
      number: 34,
      url: "https://github.com/lm4sci/lm4sci.github.io/pull/34",
      headRefName: DEFAULT_INSTALL_BRANCH,
      headRepositoryOwner: { login: "sepo-install-bot" },
    }];

    const result = publishInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir: tempDir,
      forkRepo: "sepo-install-bot/lm4sci.github.io",
      bodyFile,
      runner,
    });

    assert.equal(result.status, "published");
    assert.equal(result.reusedPr, true);
    assert.equal(result.prUrl, "https://github.com/lm4sci/lm4sci.github.io/pull/34");
    assert.ok(runner.called("git", /push https:\/\/x-access-token:pat-token@github\.com\/sepo-install-bot\/lm4sci\.github\.io\.git HEAD:agent\/install-agent-infra/));
    assert.equal(runner.called("gh", /pr create/), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publishInstallForkPr pushes and opens a new install PR", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "install-fork-pr-"));
  const bodyFile = join(tempDir, "body.md");
  writeFileSync(bodyFile, "Install Sepo.\n", "utf8");

  try {
    const runner = new FakeRunner();
    runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
    runner.repos.set(
      "sepo-install-bot/lm4sci.github.io",
      repoRecord("sepo-install-bot/lm4sci.github.io", {
        fork: true,
        parent: "lm4sci/lm4sci.github.io",
      }),
    );

    const result = publishInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir: tempDir,
      forkRepo: "sepo-install-bot/lm4sci.github.io",
      title: "Install Sepo agent infrastructure",
      bodyFile,
      runner,
    });

    assert.equal(result.status, "published");
    assert.equal(result.reusedPr, false);
    assert.equal(result.prUrl, "https://github.com/lm4sci/lm4sci.github.io/pull/77");
    assert.equal(result.prNumber, "77");
    assert.ok(runner.called("git", /push https:\/\/x-access-token:pat-token@github\.com\/sepo-install-bot\/lm4sci\.github\.io\.git HEAD:agent\/install-agent-infra/));
    assert.ok(runner.called("gh", /pr create --repo lm4sci\/lm4sci\.github\.io --base main --head sepo-install-bot:agent\/install-agent-infra --title Install Sepo agent infrastructure --body-file/));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publishInstallForkPr reruns update an existing fork branch without a non-fast-forward push", () => {
  const root = mkdtempSync(join(tmpdir(), "install-fork-pr-git-"));
  const workdir = join(root, "install-work");
  const bodyFile = join(root, "body.md");
  writeFileSync(bodyFile, "Install Sepo.\n", "utf8");

  try {
    const { targetBare, forkBare } = createGitFixture(root);
    const runner = new GitFixtureRunner(new Map([
      ["lm4sci/lm4sci.github.io", targetBare],
      ["sepo-install-bot/lm4sci.github.io", forkBare],
    ]));
    runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
    runner.repos.set(
      "sepo-install-bot/lm4sci.github.io",
      repoRecord("sepo-install-bot/lm4sci.github.io", {
        fork: true,
        parent: "lm4sci/lm4sci.github.io",
      }),
    );
    runner.prs = [{
      number: 34,
      url: "https://github.com/lm4sci/lm4sci.github.io/pull/34",
      headRefName: DEFAULT_INSTALL_BRANCH,
      headRepositoryOwner: { login: "sepo-install-bot" },
    }];

    const prepared = prepareInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir,
      forkPollAttempts: 1,
      runner,
    });

    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.reusedPr, true);
    assert.ok(runner.called("git", /fetch --depth 1 install-fork agent\/install-agent-infra/));

    commitFile(workdir, "agent.txt", "new install\n", "Update install");
    const localHead = runGit(["rev-parse", "HEAD"], workdir);

    const published = publishInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir,
      forkRepo: "sepo-install-bot/lm4sci.github.io",
      bodyFile,
      runner,
    });

    assert.equal(published.status, "published");
    assert.equal(published.reusedPr, true);
    assert.equal(published.prUrl, "https://github.com/lm4sci/lm4sci.github.io/pull/34");
    assert.equal(
      runGit(["--git-dir", forkBare, "rev-parse", `refs/heads/${DEFAULT_INSTALL_BRANCH}`], root),
      localHead,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishInstallForkPr reports push failures as blocked permission gaps", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "install-fork-pr-"));
  const bodyFile = join(tempDir, "body.md");
  writeFileSync(bodyFile, "Install Sepo.\n", "utf8");

  try {
    const runner = new FakeRunner();
    runner.failPush = true;
    runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
    runner.repos.set(
      "sepo-install-bot/lm4sci.github.io",
      repoRecord("sepo-install-bot/lm4sci.github.io", {
        fork: true,
        parent: "lm4sci/lm4sci.github.io",
      }),
    );

    const result = publishInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir: tempDir,
      forkRepo: "sepo-install-bot/lm4sci.github.io",
      bodyFile,
      runner,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockedCode, "push_failed");
    assert.equal(runner.called("gh", /pr create/), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
