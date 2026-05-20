import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  type CommandRunner,
  DEFAULT_INSTALL_BRANCH,
  INSTALL_PREPARE_STATE_FILE,
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
  readonly remoteBranches = new Set<string>();
  prs: Array<Record<string, unknown>> = [];
  createdPrUrl = "https://github.com/lm4sci/lm4sci.github.io/pull/77";
  failPush = false;
  failMerge = false;
  currentBranch = DEFAULT_INSTALL_BRANCH;

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
      const headIndex = args.indexOf("--head");
      if (headIndex >= 0) {
        const head = args[headIndex + 1] || "";
        return JSON.stringify(this.prs.filter((pr) => pr.headRefName === head));
      }
      return JSON.stringify(this.prs.slice(0, 30));
    }

    if (args[0] === "pr" && args[1] === "create") {
      return `${this.createdPrUrl}\n`;
    }

    if (args[0] === "pr" && args[1] === "edit") {
      return "";
    }

    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  }

  git(args: string[], cwd: string): string {
    this.calls.push({ tool: "git", args: [...args], cwd });
    if (args[0] === "ls-remote") {
      const repo = String(args[2] || "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
      const branch = String(args[3] || "");
      return this.remoteBranches.has(`${repo}#${branch}`) ? `abc123\trefs/heads/${branch}\n` : "";
    }
    if (args.join(" ") === "symbolic-ref --quiet --short HEAD") {
      return `${this.currentBranch}\n`;
    }
    if (this.failMerge && args[0] === "merge") throw new Error("merge conflict");
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

function writePrepareState(workdir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(workdir, ".git"), { recursive: true });
  writeFileSync(
    join(workdir, ".git", INSTALL_PREPARE_STATE_FILE),
    `${JSON.stringify({
      schemaVersion: 1,
      targetRepo: "lm4sci/lm4sci.github.io",
      defaultBranch: "main",
      branch: DEFAULT_INSTALL_BRANCH,
      tokenOwner: "sepo-install-bot",
      forkRepo: "sepo-install-bot/lm4sci.github.io",
      ...overrides,
    }, null, 2)}\n`,
    "utf8",
  );
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
  assert.ok(runner.called("git", /branch sepo-target-default HEAD/));
  assert.ok(runner.called("git", /checkout -B agent\/install-agent-infra/));
});

test("prepareInstallForkPr reuses an existing token-owner fork without an open PR", () => {
  const runner = new FakeRunner();
  runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
  runner.repos.set(
    "sepo-install-bot/lm4sci.github.io",
    repoRecord("sepo-install-bot/lm4sci.github.io", {
      fork: true,
      parent: "lm4sci/lm4sci.github.io",
    }),
  );

  const result = prepareInstallForkPr({
    targetRepo: "lm4sci/lm4sci.github.io",
    githubToken: "pat-token",
    workdir: "/tmp/lm4sci-existing-fork-install",
    runner,
  });

  assert.equal(result.status, "prepared");
  assert.equal(result.forkRepo, "sepo-install-bot/lm4sci.github.io");
  assert.equal(result.reusedPr, false);
  assert.equal(result.prUrl, "");
  assert.equal(runner.called("gh", /forks/), false);
  assert.ok(runner.called("git", /ls-remote --heads https:\/\/github\.com\/sepo-install-bot\/lm4sci\.github\.io\.git agent\/install-agent-infra/));
  assert.ok(runner.called("git", /checkout -B agent\/install-agent-infra$/));
});

test("prepareInstallForkPr blocks when the token-owner fork name is occupied", () => {
  const runner = new FakeRunner();
  runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
  runner.repos.set("sepo-install-bot/lm4sci.github.io", repoRecord("sepo-install-bot/lm4sci.github.io"));

  const result = prepareInstallForkPr({
    targetRepo: "lm4sci/lm4sci.github.io",
    githubToken: "pat-token",
    runner,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.blockedCode, "fork_name_occupied");
  assert.match(result.message, /not a fork of lm4sci\/lm4sci\.github\.io/);
  assert.equal(runner.called("gh", /forks/), false);
  assert.equal(runner.called("git", /clone/), false);
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
  assert.ok(runner.called("git", /fetch install-fork agent\/install-agent-infra/));
  assert.ok(runner.called("git", /checkout -B agent\/install-agent-infra FETCH_HEAD/));
  assert.ok(runner.called("git", /merge --no-edit sepo-target-default/));
});

test("prepareInstallForkPr finds reusable install PRs outside the default list window", () => {
  const runner = new FakeRunner();
  runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
  runner.repos.set(
    "sepo-install-bot/lm4sci.github.io",
    repoRecord("sepo-install-bot/lm4sci.github.io", {
      fork: true,
      parent: "lm4sci/lm4sci.github.io",
    }),
  );
  runner.prs = [
    ...Array.from({ length: 30 }, (_, i) => ({
      number: i + 1,
      url: `https://github.com/lm4sci/lm4sci.github.io/pull/${i + 1}`,
      headRefName: `feature-${i + 1}`,
      headRepositoryOwner: { login: "contributor" },
    })),
    {
      number: 61,
      url: "https://github.com/lm4sci/lm4sci.github.io/pull/61",
      headRefName: DEFAULT_INSTALL_BRANCH,
      headRepositoryOwner: { login: "sepo-install-bot" },
    },
  ];

  const result = prepareInstallForkPr({
    targetRepo: "lm4sci/lm4sci.github.io",
    githubToken: "pat-token",
    workdir: "/tmp/lm4sci-install-paginated-reuse",
    runner,
  });

  assert.equal(result.status, "prepared");
  assert.equal(result.reusedPr, true);
  assert.equal(result.prUrl, "https://github.com/lm4sci/lm4sci.github.io/pull/61");
  assert.ok(runner.called("gh", /pr list --repo lm4sci\/lm4sci\.github\.io --state open --head agent\/install-agent-infra/));
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

test("prepareInstallForkPr finds duplicate install PRs outside the default list window", () => {
  const runner = new FakeRunner();
  runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
  runner.prs = [
    ...Array.from({ length: 30 }, (_, i) => ({
      number: i + 1,
      url: `https://github.com/lm4sci/lm4sci.github.io/pull/${i + 1}`,
      headRefName: `feature-${i + 1}`,
      headRepositoryOwner: { login: "contributor" },
    })),
    {
      number: 62,
      url: "https://github.com/lm4sci/lm4sci.github.io/pull/62",
      headRefName: DEFAULT_INSTALL_BRANCH,
      headRepositoryOwner: { login: "other-bot" },
    },
  ];

  const result = prepareInstallForkPr({
    targetRepo: "lm4sci/lm4sci.github.io",
    githubToken: "pat-token",
    runner,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.blockedCode, "duplicate_install_pr");
  assert.match(result.message, /other-bot:agent\/install-agent-infra/);
  assert.equal(runner.called("gh", /forks/), false);
  assert.ok(runner.called("gh", /pr list --repo lm4sci\/lm4sci\.github\.io --state open --head agent\/install-agent-infra/));
});

test("publishInstallForkPr pushes and reuses an existing install PR from the token owner", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "install-fork-pr-"));
  const bodyFile = join(tempDir, "body.md");
  writeFileSync(
    bodyFile,
    [
      "## Summary",
      "",
      "Installs Sepo.",
      "",
      "## Source revision",
      "",
      "- Source repository: `self-evolving/repo`",
      "",
      "## Validation",
      "",
      "- Checked the staged diff.",
      "",
      "## Required setup after merge",
      "",
      "1. Old unlinked setup guidance.",
      "",
      "Source install request: https://github.com/self-evolving/repo/issues/303",
      "<!-- sepo-install-source-request: https://github.com/self-evolving/repo/issues/303 -->",
      "",
    ].join("\n"),
    "utf8",
  );
  writePrepareState(tempDir);

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
      sourceRequestUrl: "https://github.com/self-evolving/repo/issues/303",
      runner,
    });

    assert.equal(result.status, "published");
    assert.equal(result.reusedPr, true);
    assert.equal(result.prUrl, "https://github.com/lm4sci/lm4sci.github.io/pull/34");
    const body = readFileSync(bodyFile, "utf8");
    assert.ok(body.indexOf("## Summary") < body.indexOf("## Required setup after merge"));
    assert.ok(body.indexOf("## Required setup after merge") < body.indexOf("## Source revision"));
    assert.match(body, /https:\/\/github\.com\/apps\/sepo-agent-app\/installations\/select_target/);
    assert.match(body, /https:\/\/github\.com\/lm4sci\/lm4sci\.github\.io\/settings\/secrets\/actions/);
    assert.match(body, /https:\/\/github\.com\/lm4sci\/lm4sci\.github\.io\/actions\/workflows\/agent-onboarding\.yml/);
    assert.match(body, /https:\/\/github\.com\/lm4sci\/lm4sci\.github\.io\/actions\/workflows\/agent-memory-bootstrap\.yml/);
    assert.match(body, /https:\/\/github\.com\/lm4sci\/lm4sci\.github\.io\/actions\/workflows\/agent-rubrics-initialization\.yml/);
    assert.match(body, /Source install request: https:\/\/github\.com\/self-evolving\/repo\/issues\/303/);
    assert.equal(body.match(/Source install request:/g)?.length, 1);
    assert.doesNotMatch(body, /Old unlinked setup guidance/);
    assert.ok(runner.called("git", /push https:\/\/x-access-token:pat-token@github\.com\/sepo-install-bot\/lm4sci\.github\.io\.git HEAD:agent\/install-agent-infra/));
    assert.ok(runner.called("gh", /pr edit 34 --repo lm4sci\/lm4sci\.github\.io --body-file/));
    assert.equal(runner.called("gh", /pr create/), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publishInstallForkPr pushes and opens a new install PR", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "install-fork-pr-"));
  const bodyFile = join(tempDir, "body.md");
  writeFileSync(bodyFile, "Install Sepo.\n", "utf8");
  writePrepareState(tempDir);

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
      sourceRequestUrl: "https://github.com/self-evolving/repo/issues/303?from=template",
      runner,
    });

    assert.equal(result.status, "published");
    assert.equal(result.reusedPr, false);
    assert.equal(result.prUrl, "https://github.com/lm4sci/lm4sci.github.io/pull/77");
    assert.equal(result.prNumber, "77");
    assert.match(readFileSync(bodyFile, "utf8"), /Source install request: https:\/\/github\.com\/self-evolving\/repo\/issues\/303/);
    assert.ok(runner.called("git", /push https:\/\/x-access-token:pat-token@github\.com\/sepo-install-bot\/lm4sci\.github\.io\.git HEAD:agent\/install-agent-infra/));
    assert.ok(runner.called("gh", /pr create --repo lm4sci\/lm4sci\.github\.io --base main --head sepo-install-bot:agent\/install-agent-infra --title Install Sepo agent infrastructure --body-file/));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publishInstallForkPr rejects target repo as fork when token owner differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "install-fork-pr-"));
  const bodyFile = join(tempDir, "body.md");
  writeFileSync(bodyFile, "Install Sepo.\n", "utf8");

  try {
    const runner = new FakeRunner();
    runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));

    const result = publishInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir: tempDir,
      forkRepo: "lm4sci/lm4sci.github.io",
      bodyFile,
      runner,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockedCode, "fork_owner_mismatch");
    assert.match(result.message, /not owned by the AGENT_INSTALL_PAT token owner sepo-install-bot/);
    assert.equal(runner.called("git", /push/), false);
    assert.equal(runner.called("gh", /pr create/), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publishInstallForkPr requires prepare state before pushing", () => {
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
      bodyFile,
      runner,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockedCode, "missing_prepare_state");
    assert.equal(runner.called("git", /push/), false);
    assert.equal(runner.called("gh", /pr create/), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publishInstallForkPr rejects mismatched prepare state before pushing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "install-fork-pr-"));
  const bodyFile = join(tempDir, "body.md");
  writeFileSync(bodyFile, "Install Sepo.\n", "utf8");
  writePrepareState(tempDir, { forkRepo: "other-bot/lm4sci.github.io" });

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
      bodyFile,
      runner,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockedCode, "prepare_state_mismatch");
    assert.equal(runner.called("git", /push/), false);
    assert.equal(runner.called("gh", /pr create/), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publishInstallForkPr blocks when prepared workdir is on the wrong branch", () => {
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

    const prepared = prepareInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir,
      forkPollAttempts: 1,
      runner,
    });

    assert.equal(prepared.status, "prepared");
    runGit(["checkout", "-B", "not-the-install-branch"], workdir);

    const published = publishInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir,
      forkRepo: "sepo-install-bot/lm4sci.github.io",
      bodyFile,
      runner,
    });

    assert.equal(published.status, "blocked");
    assert.equal(published.blockedCode, "workdir_branch_mismatch");
    assert.match(published.message, /not-the-install-branch/);
    assert.equal(runner.called("git", /push/), false);
    assert.equal(runner.called("gh", /pr create/), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    assert.ok(runner.called("git", /fetch install-fork agent\/install-agent-infra/));

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

test("publishInstallForkPr recovers a stale fork branch when no open PR exists", () => {
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

    const prepared = prepareInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir,
      forkPollAttempts: 1,
      runner,
    });

    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.reusedPr, false);
    assert.ok(runner.called("git", /ls-remote --heads https:\/\/github\.com\/sepo-install-bot\/lm4sci\.github\.io\.git agent\/install-agent-infra/));
    assert.ok(runner.called("git", /fetch install-fork agent\/install-agent-infra/));

    commitFile(workdir, "agent.txt", "new install after closed pr\n", "Update stale install");
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
    assert.equal(published.reusedPr, false);
    assert.equal(published.prUrl, "https://github.com/lm4sci/lm4sci.github.io/pull/77");
    assert.equal(
      runGit(["--git-dir", forkBare, "rev-parse", `refs/heads/${DEFAULT_INSTALL_BRANCH}`], root),
      localHead,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareInstallForkPr merges an advanced target default into an existing fork branch", () => {
  const root = mkdtempSync(join(tmpdir(), "install-fork-pr-git-"));
  const workdir = join(root, "install-work");

  try {
    const { targetBare, forkBare } = createGitFixture(root);
    const targetAdvance = join(root, "target-advance");
    runGit(["clone", targetBare, targetAdvance], root);
    configureGitUser(targetAdvance);
    commitFile(targetAdvance, "target-owned.txt", "advanced target default\n", "Advance target default");
    runGit(["push", "origin", "main"], targetAdvance);

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

    const prepared = prepareInstallForkPr({
      targetRepo: "lm4sci/lm4sci.github.io",
      githubToken: "pat-token",
      workdir,
      forkPollAttempts: 1,
      runner,
    });

    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.reusedPr, false);
    assert.equal(readFileSync(join(workdir, "target-owned.txt"), "utf8"), "advanced target default\n");
    assert.ok(runner.called("git", /merge --no-edit sepo-target-default/));
    const mergeIndex = runner.calls.findIndex((call) => call.tool === "git" && call.args[0] === "merge");
    const nameConfigIndex = runner.calls.findIndex((call) => (
      call.tool === "git" && call.args.join(" ") === "config user.name sepo-agent"
    ));
    const emailConfigIndex = runner.calls.findIndex((call) => (
      call.tool === "git" &&
      call.args.join(" ") === "config user.email 279869237+sepo-agent@users.noreply.github.com"
    ));
    assert.ok(nameConfigIndex >= 0 && nameConfigIndex < mergeIndex);
    assert.ok(emailConfigIndex >= 0 && emailConfigIndex < mergeIndex);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareInstallForkPr reports target default merge conflicts clearly", () => {
  const runner = new FakeRunner();
  runner.failMerge = true;
  runner.repos.set("lm4sci/lm4sci.github.io", repoRecord("lm4sci/lm4sci.github.io"));
  runner.repos.set(
    "sepo-install-bot/lm4sci.github.io",
    repoRecord("sepo-install-bot/lm4sci.github.io", {
      fork: true,
      parent: "lm4sci/lm4sci.github.io",
    }),
  );
  runner.remoteBranches.add(`sepo-install-bot/lm4sci.github.io#${DEFAULT_INSTALL_BRANCH}`);

  const result = prepareInstallForkPr({
    targetRepo: "lm4sci/lm4sci.github.io",
    githubToken: "pat-token",
    workdir: "/tmp/lm4sci-conflicting-install",
    forkPollAttempts: 1,
    runner,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.blockedCode, "target_default_merge_conflict");
  assert.match(result.message, /conflicts with current lm4sci\/lm4sci\.github\.io:main/);
  assert.ok(runner.called("git", /merge --no-edit sepo-target-default/));
});

test("publishInstallForkPr reports push failures as blocked permission gaps", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "install-fork-pr-"));
  const bodyFile = join(tempDir, "body.md");
  writeFileSync(bodyFile, "Install Sepo.\n", "utf8");
  writePrepareState(tempDir);

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
