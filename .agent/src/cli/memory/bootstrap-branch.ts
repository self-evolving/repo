#!/usr/bin/env node
// CLI: initialize a local agent/memory branch inside the current git repo.
// Usage: node .agent/dist/cli/memory/bootstrap-branch.js [--repo <slug>] [--branch <name>] [--remote <name>]
// Env: REPO_SLUG, GITHUB_REPOSITORY

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { ensureMemoryStructure } from "../../memory-artifacts.js";
import {
  commit,
  configureBotIdentity,
  git,
  hasStagedChanges,
  stageAll,
} from "../../git.js";

const DEFAULT_BRANCH = "agent/memory";
const DEFAULT_REMOTE = "origin";

const USAGE = [
  "Usage: memory/bootstrap-branch.js [--repo <slug>] [--branch <name>] [--remote <name>]",
  "",
  "Options:",
  `  --repo <slug>      Repository slug used in seeded stubs (defaults to REPO_SLUG, GITHUB_REPOSITORY, or ${DEFAULT_REMOTE} remote URL)`,
  `  --branch <name>    Memory branch to create or update (default: ${DEFAULT_BRANCH})`,
  `  --remote <name>    Remote used for repo-slug inference and next-step hints (default: ${DEFAULT_REMOTE})`,
  "  -h, --help         Show this message",
  "",
  "This command creates or updates a local memory branch and seeds PROJECT.md / MEMORY.md",
  "without changing your current checkout. Push it separately when ready.",
  "",
].join("\n");

interface WritableLike { write(chunk: string): void; }

interface ParsedBootstrapArgs {
  repo: string;
  branch: string;
  remote: string;
  help: boolean;
}

const ARG_CONFIG = {
  options: {
    repo: { type: "string" },
    branch: { type: "string" },
    remote: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
  strict: true,
} as const satisfies ParseArgsConfig;

export function parseGitHubRepoSlugFromRemoteUrl(url: string): string {
  const match = url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  return match?.[1] || "";
}

function hasLocalBranch(branch: string, repoRoot: string): boolean {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

function hasRemoteTrackingBranch(branch: string, remote: string, repoRoot: string): boolean {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

function currentBranch(repoRoot: string): string {
  try {
    return git(["branch", "--show-current"], repoRoot);
  } catch {
    return "";
  }
}

function inferRepoSlug(repoRoot: string, remote: string): string {
  try {
    return parseGitHubRepoSlugFromRemoteUrl(git(["remote", "get-url", remote], repoRoot));
  } catch {
    return "";
  }
}

export function parseMemoryBootstrapBranchArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ParsedBootstrapArgs {
  const { values } = parseArgs({ ...ARG_CONFIG, args: argv });
  const remote = (values.remote as string | undefined) || DEFAULT_REMOTE;
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);

  return {
    repo: (values.repo as string | undefined)
      || env.REPO_SLUG
      || env.GITHUB_REPOSITORY
      || inferRepoSlug(repoRoot, remote),
    branch: (values.branch as string | undefined) || DEFAULT_BRANCH,
    remote,
    help: Boolean(values.help),
  };
}

export function runMemoryBootstrapBranchCli(
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdout?: WritableLike;
    stderr?: WritableLike;
  } = {},
): number {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  let args: ParsedBootstrapArgs;
  let repoRoot = "";
  try {
    repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
    args = parseMemoryBootstrapBranchArgs(argv, env, cwd);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n\n${USAGE}`);
    return 1;
  }

  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }

  if (!args.repo || !args.repo.includes("/")) {
    stderr.write(
      `Missing or invalid repository slug (got: ${args.repo || "empty"}).\n`
      + `Pass --repo <owner/repo> or configure a GitHub origin remote.\n\n${USAGE}`,
    );
    return 1;
  }

  const worktreeDir = mkdtempSync(join(tmpdir(), "agent-memory-bootstrap-"));
  let addedWorktree = false;

  try {
    const branchExists = hasLocalBranch(args.branch, repoRoot);
    const remoteBranchExists = !branchExists && hasRemoteTrackingBranch(args.branch, args.remote, repoRoot);
    const checkedOutBranch = currentBranch(repoRoot);

    if (branchExists && checkedOutBranch === args.branch) {
      stderr.write(
        `Branch ${args.branch} is already checked out in the current worktree.\n`
        + "Switch to another branch before rerunning bootstrap.\n",
      );
      return 1;
    }

    git(["worktree", "add", "--detach", worktreeDir, "HEAD"], repoRoot);
    addedWorktree = true;

    if (branchExists) {
      git(["checkout", args.branch], worktreeDir);
    } else if (remoteBranchExists) {
      git(["checkout", "-b", args.branch, `${args.remote}/${args.branch}`], worktreeDir);
    } else {
      git(["checkout", "--orphan", args.branch], worktreeDir);
      try { git(["rm", "-rf", "."], worktreeDir); } catch { /* ok */ }
      try { git(["clean", "-fdx"], worktreeDir); } catch { /* ok */ }
    }

    const initResult = ensureMemoryStructure(worktreeDir, args.repo);
    configureBotIdentity(worktreeDir);
    stageAll(worktreeDir);

    let committed = false;
    if (hasStagedChanges(worktreeDir)) {
      commit("chore(memory): initialize memory branch", worktreeDir);
      committed = true;
    }

    stdout.write(
      `${JSON.stringify(
        {
          repoRoot,
          repo: args.repo,
          branch: args.branch,
          remote: args.remote,
          createdBranch: !branchExists,
          committed,
          createdFiles: initResult.createdFiles.map((file) => file.replace(`${worktreeDir}/`, "")),
          nextStep: `git push ${args.remote} ${args.branch}`,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error: unknown) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (addedWorktree) {
      try { git(["worktree", "remove", "--force", worktreeDir], repoRoot); } catch { /* ok */ }
    }
    try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

if (require.main === module) {
  process.exitCode = runMemoryBootstrapBranchCli(process.argv.slice(2));
}
