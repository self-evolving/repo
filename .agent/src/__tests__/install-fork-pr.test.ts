import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
