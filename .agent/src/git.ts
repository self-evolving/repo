// Git helpers for workflow post-processing steps.
//
// These functions wrap the git CLI operations that workflows perform after
// the agent completes: branch management, committing, and pushing.
//
// The low-level `git()` runner and `buildAuthUrl()` are also used by
// thread-state-git.ts for ref-based state storage.

import { execFileSync } from "node:child_process";

const DEFAULT_BOT_NAME = "sepo-agent";
const DEFAULT_BOT_EMAIL = "279869237+sepo-agent@users.noreply.github.com";
const GIT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/** Excluded patterns for git add (secrets, private keys). */
const ADD_EXCLUDES = [":!.env*", ":!*.pem", ":!*.key"];

// ---------------------------------------------------------------------------
// Low-level primitives (shared across modules)
// ---------------------------------------------------------------------------

/**
 * Runs a git command synchronously and returns trimmed stdout.
 * Accepts optional stdin input for commands like `hash-object --stdin`
 * and `mktree`.
 */
export function git(
  args: string[],
  cwd: string,
  input?: string,
): string {
  return execFileSync("git", args, {
    cwd,
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  }).toString("utf8").trim();
}

/**
 * Builds an authenticated HTTPS remote URL for pushing.
 * Used by branch push helpers and thread-state ref pushes.
 */
export function buildAuthUrl(token: string, repo: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

export function configureBotIdentity(cwd: string, name?: string, email?: string): void {
  const botName = name || process.env.GIT_BOT_NAME || DEFAULT_BOT_NAME;
  const botEmail = email || process.env.GIT_BOT_EMAIL || DEFAULT_BOT_EMAIL;
  execFileSync("git", ["config", "user.name", botName], { cwd, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", botEmail], { cwd, stdio: "pipe" });
}

export function createBranch(baseBranch: string, branchName: string, cwd: string): void {
  execFileSync("git", ["checkout", "-b", branchName, baseBranch], { cwd, stdio: "pipe" });
}

export function hasChanges(cwd: string): boolean {
  const output = execFileSync("git", ["status", "--porcelain"], { cwd, stdio: "pipe" })
    .toString("utf8")
    .trim();
  return output.length > 0;
}

export function currentHead(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd);
}

export function hasHeadChanged(originalHead: string, cwd: string): boolean {
  return Boolean(originalHead) && currentHead(cwd) !== originalHead;
}

export function hasStagedChanges(cwd: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd, stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
}

export function stageAll(cwd: string): void {
  execFileSync("git", ["add", "-A", "--", ...ADD_EXCLUDES], { cwd, stdio: "pipe" });
}

export function commit(message: string, cwd: string): void {
  execFileSync("git", ["commit", "-m", message], { cwd, stdio: "pipe" });
}

export function pushBranch(
  branch: string,
  token: string,
  repo: string,
  cwd: string,
  opts?: { setUpstream?: boolean },
): void {
  const url = buildAuthUrl(token, repo);
  const args = ["push"];
  if (opts?.setUpstream) args.push("-u");
  args.push(url, branch);
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

export function buildPushToRefArgs(
  remoteUrl: string,
  headRef: string,
  opts?: { forceWithLeaseOid?: string },
): string[] {
  const args = ["push"];
  if (opts?.forceWithLeaseOid) {
    args.push(`--force-with-lease=refs/heads/${headRef}:${opts.forceWithLeaseOid}`);
  }
  args.push(remoteUrl, `HEAD:${headRef}`);
  return args;
}

export function pushToRef(
  headRef: string,
  token: string,
  repo: string,
  cwd: string,
  opts?: { forceWithLeaseOid?: string },
): void {
  const url = buildAuthUrl(token, repo);
  execFileSync("git", buildPushToRefArgs(url, headRef, opts), { cwd, stdio: "pipe" });
}

export function cleanupBranch(
  branchName: string,
  baseBranch: string,
  cwd: string,
): void {
  try { execFileSync("git", ["checkout", "-f", baseBranch], { cwd, stdio: "pipe" }); } catch { /* ok */ }
  try { execFileSync("git", ["branch", "-D", branchName], { cwd, stdio: "pipe" }); } catch { /* ok */ }
  try { execFileSync("git", ["reset", "--hard", "HEAD"], { cwd, stdio: "pipe" }); } catch { /* ok */ }
  try { execFileSync("git", ["clean", "-fd"], { cwd, stdio: "pipe" }); } catch { /* ok */ }
}

export function cleanupWorktree(baseBranch: string, cwd: string): void {
  try { execFileSync("git", ["reset", "--hard", "HEAD"], { cwd, stdio: "pipe" }); } catch { /* ok */ }
  try { execFileSync("git", ["clean", "-fd"], { cwd, stdio: "pipe" }); } catch { /* ok */ }
  try { execFileSync("git", ["checkout", "-f", baseBranch], { cwd, stdio: "pipe" }); } catch { /* ok */ }
}

export interface CommitAndPushResult {
  committed: boolean;
  branch: string;
}

/**
 * Stages, commits, and pushes changes. Returns whether a commit was made.
 * Skips if there are no staged changes after git add.
 */
export function commitAndPush(opts: {
  message: string;
  branch: string;
  token: string;
  repo: string;
  cwd: string;
  setUpstream?: boolean;
  pushRef?: string;
  pushLeaseOid?: string;
}): CommitAndPushResult {
  stageAll(opts.cwd);
  if (!hasStagedChanges(opts.cwd)) {
    return { committed: false, branch: opts.branch };
  }
  commit(opts.message, opts.cwd);
  if (opts.pushRef) {
    pushToRef(opts.pushRef, opts.token, opts.repo, opts.cwd, {
      forceWithLeaseOid: opts.pushLeaseOid,
    });
  } else {
    pushBranch(opts.branch, opts.token, opts.repo, opts.cwd, {
      setUpstream: opts.setUpstream,
    });
  }
  return { committed: true, branch: opts.branch };
}

export function pushHeadUpdate(opts: {
  branch: string;
  token: string;
  repo: string;
  cwd: string;
  expectedHead: string;
}): void {
  pushToRef(opts.branch, opts.token, opts.repo, opts.cwd, {
    forceWithLeaseOid: opts.expectedHead,
  });
}
