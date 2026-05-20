#!/usr/bin/env node
// CLI: prepare ignored local memory/rubrics checkouts for local coding agents.
// Usage: node .agent/dist/cli/local/prepare-agent-context.js [--repo <owner/repo>] [--dir <path>]

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { git } from "../../git.js";
import { parseGitHubRepoSlugFromRemoteUrl } from "../memory/bootstrap-branch.js";

const DEFAULT_CONTEXT_DIR = ".agent/local";
const DEFAULT_REMOTE = "origin";
const DEFAULT_MEMORY_REF = "agent/memory";
const DEFAULT_RUBRICS_REF = "agent/rubrics";
const CONTEXT_FILE = "AGENT_CONTEXT.md";

const USAGE = [
  "Usage: local/prepare-agent-context.js [--repo <owner/repo>] [--dir <path>] [--remote <name-or-url>]",
  "",
  "Options:",
  "  --repo <slug>          Repository slug used for hints (defaults to REPO_SLUG, GITHUB_REPOSITORY, or origin URL)",
  `  --dir <path>           Local context directory (default: ${DEFAULT_CONTEXT_DIR})`,
  `  --remote <name-or-url> Remote name or clone URL (default: ${DEFAULT_REMOTE})`,
  `  --memory-ref <ref>     Memory branch to clone (default: ${DEFAULT_MEMORY_REF})`,
  `  --rubrics-ref <ref>    Rubrics branch to clone (default: ${DEFAULT_RUBRICS_REF})`,
  "  -h, --help             Show this message",
  "",
  "Missing memory/rubrics branches are non-fatal; the generated context file",
  "explains the GitHub Actions initialization workflow to run next.",
  "",
].join("\n");

interface WritableLike { write(chunk: string): void; }

interface ParsedPrepareLocalAgentContextArgs {
  repo: string;
  dir: string;
  remote: string;
  memoryRef: string;
  rubricsRef: string;
  help: boolean;
}

interface CheckoutResult {
  name: "memory" | "rubrics";
  ref: string;
  dir: string;
  available: boolean;
  cloned: boolean;
  reason?: string;
  nextStep?: string;
}

interface RemoteResolution {
  input: string;
  url: string;
}

const ARG_CONFIG = {
  options: {
    repo: { type: "string" },
    dir: { type: "string" },
    remote: { type: "string" },
    "memory-ref": { type: "string" },
    "rubrics-ref": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
  strict: true,
} as const satisfies ParseArgsConfig;

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  }).toString("utf8").trim();
}

function commandStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isRemoteName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function inferRepoSlug(repoRoot: string, remote: string): string {
  try {
    return parseGitHubRepoSlugFromRemoteUrl(runGit(["remote", "get-url", remote], repoRoot));
  } catch {
    return "";
  }
}

function resolveRemote(input: string, repoRoot: string): RemoteResolution {
  if (isRemoteName(input)) {
    try {
      return { input, url: runGit(["remote", "get-url", input], repoRoot) };
    } catch {
      // Fall through and treat the input as a URL/path. Git will produce the
      // concrete clone error if it cannot use it.
    }
  }
  return { input, url: input };
}

function branchExists(remoteUrl: string, ref: string, cwd: string): boolean {
  try {
    runGit(["ls-remote", "--exit-code", "--heads", remoteUrl, ref], cwd);
    return true;
  } catch (error: unknown) {
    if (commandStatus(error) === 2) return false;
    throw error;
  }
}

function refreshCheckout(opts: {
  name: "memory" | "rubrics";
  ref: string;
  dir: string;
  remoteUrl: string;
  repoSlug: string;
  repoRoot: string;
}): CheckoutResult {
  if (!branchExists(opts.remoteUrl, opts.ref, opts.repoRoot)) {
    const workflow = opts.name === "memory"
      ? "Agent / Memory / Initialization"
      : "Agent / Rubrics / Initialization";
    return {
      name: opts.name,
      ref: opts.ref,
      dir: opts.dir,
      available: false,
      cloned: false,
      reason: `Branch ${opts.ref} was not found.`,
      nextStep: opts.repoSlug
        ? `Run ${workflow} in https://github.com/${opts.repoSlug}/actions to initialize ${opts.ref}.`
        : `Run ${workflow} in GitHub Actions to initialize ${opts.ref}.`,
    };
  }

  rmSync(opts.dir, { recursive: true, force: true });
  mkdirSync(dirname(opts.dir), { recursive: true });
  execFileSync(
    "git",
    ["clone", "--depth=1", "--branch", opts.ref, "--single-branch", opts.remoteUrl, opts.dir],
    {
      cwd: opts.repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  return {
    name: opts.name,
    ref: opts.ref,
    dir: opts.dir,
    available: true,
    cloned: true,
  };
}

function posixRelative(from: string, to: string): string {
  const rel = relative(from, to) || ".";
  return rel.split("\\").join("/");
}

function formatPath(repoRoot: string, path: string): string {
  return isAbsolute(path) ? posixRelative(repoRoot, path) : path;
}

function checkoutLine(repoRoot: string, result: CheckoutResult): string {
  const path = formatPath(repoRoot, result.dir);
  if (result.available) {
    return `- ${result.name}: ${path} (${result.ref})`;
  }
  return `- ${result.name}: unavailable (${result.reason || `${result.ref} is missing`})`;
}

function buildAgentContextMarkdown(opts: {
  repo: string;
  repoRoot: string;
  contextDir: string;
  memory: CheckoutResult;
  rubrics: CheckoutResult;
}): string {
  const memoryPath = formatPath(opts.repoRoot, opts.memory.dir);
  const rubricsPath = formatPath(opts.repoRoot, opts.rubrics.dir);
  const contextPath = formatPath(opts.repoRoot, opts.contextDir);
  const lines = [
    "# Local Agent Context",
    "",
    "Generated by `npm --prefix .agent run prepare:local-agent`.",
    "",
    "This ignored workspace gives local coding agents the same durable context that Sepo mounts in GitHub Actions.",
    "",
    "## Checkouts",
    "",
    checkoutLine(opts.repoRoot, opts.memory),
    checkoutLine(opts.repoRoot, opts.rubrics),
    `- context workspace: ${contextPath}`,
    "",
    "## Environment",
    "",
    "```sh",
    `export MEMORY_DIR="${memoryPath}"`,
    `export RUBRICS_DIR="${rubricsPath}"`,
    "```",
    "",
    "Set only the variables whose checkouts are available.",
    "",
    "## How Local Agents Should Use This",
    "",
    "- Before work, read `AGENT.md`, then memory in this order: `PROJECT.md`, `MEMORY.md`, recent `daily/YYYY-MM-DD.md` files, and relevant `github/<owner>/<repo>/*.json` artifacts.",
    `- Search broader memory with \`node .agent/dist/cli/memory/search.js --dir "${memoryPath}" "<query>"\` when the relevant artifact is not obvious.`,
    `- For standard memory edits, use \`node .agent/dist/cli/memory/update.js ... --dir "${memoryPath}"\`; keep durable bullets terse and trust live repo/GitHub state over stale memory.`,
    "- Treat rubrics as normative user/team preferences for implementation and review. Read active rubric YAML under `rubrics/` when the selected context looks incomplete.",
    "- Do not edit rubrics during normal local implementation or review work; use the dedicated rubrics workflows for rubric initialization and updates.",
    "- After implementation, run focused checks. When the local agent supports sub-agents or parallel reviewers, launch a separate review/checking sub-agent against the final diff and applicable rubrics before handing work back.",
  ];

  const missing = [opts.memory, opts.rubrics].filter((result) => !result.available);
  if (missing.length > 0) {
    lines.push("", "## Missing Branches", "");
    for (const result of missing) {
      lines.push(`- ${result.name}: ${result.nextStep || result.reason || `${result.ref} is missing.`}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function writeAgentContextFile(opts: {
  repo: string;
  repoRoot: string;
  contextDir: string;
  memory: CheckoutResult;
  rubrics: CheckoutResult;
}): string {
  mkdirSync(opts.contextDir, { recursive: true });
  const file = join(opts.contextDir, CONTEXT_FILE);
  writeFileSync(file, buildAgentContextMarkdown(opts), "utf8");
  return file;
}

export function parsePrepareLocalAgentContextArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ParsedPrepareLocalAgentContextArgs {
  const { values } = parseArgs({ ...ARG_CONFIG, args: argv });
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  const remote = (values.remote as string | undefined) || DEFAULT_REMOTE;

  return {
    repo: (values.repo as string | undefined)
      || env.REPO_SLUG
      || env.GITHUB_REPOSITORY
      || inferRepoSlug(repoRoot, remote),
    dir: (values.dir as string | undefined) || env.AGENT_LOCAL_CONTEXT_DIR || DEFAULT_CONTEXT_DIR,
    remote,
    memoryRef: (values["memory-ref"] as string | undefined)
      || env.AGENT_MEMORY_REF
      || env.MEMORY_REF
      || DEFAULT_MEMORY_REF,
    rubricsRef: (values["rubrics-ref"] as string | undefined)
      || env.AGENT_RUBRICS_REF
      || env.RUBRICS_REF
      || DEFAULT_RUBRICS_REF,
    help: Boolean(values.help),
  };
}

export function runPrepareLocalAgentContextCli(
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

  let args: ParsedPrepareLocalAgentContextArgs;
  let repoRoot = "";
  try {
    repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
    args = parsePrepareLocalAgentContextArgs(argv, env, cwd);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n\n${USAGE}`);
    return 1;
  }

  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }

  if (args.repo && !args.repo.includes("/")) {
    stderr.write(`Invalid repository slug (got: ${args.repo}). Pass --repo <owner/repo>.\n\n${USAGE}`);
    return 1;
  }

  const contextDir = resolve(repoRoot, args.dir);
  const remote = resolveRemote(args.remote, repoRoot);

  try {
    const memory = refreshCheckout({
      name: "memory",
      ref: args.memoryRef,
      dir: join(contextDir, "memory"),
      remoteUrl: remote.url,
      repoSlug: args.repo,
      repoRoot,
    });
    const rubrics = refreshCheckout({
      name: "rubrics",
      ref: args.rubricsRef,
      dir: join(contextDir, "rubrics"),
      remoteUrl: remote.url,
      repoSlug: args.repo,
      repoRoot,
    });
    const contextFile = writeAgentContextFile({
      repo: args.repo,
      repoRoot,
      contextDir,
      memory,
      rubrics,
    });

    stdout.write(
      `${JSON.stringify(
        {
          repoRoot,
          repo: args.repo,
          remote: remote.input,
          contextDir,
          contextFile,
          memory,
          rubrics,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error: unknown) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runPrepareLocalAgentContextCli(process.argv.slice(2));
}
