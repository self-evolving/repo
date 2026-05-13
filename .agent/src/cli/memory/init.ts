#!/usr/bin/env node
// CLI: initialize the agent memory tree in a local directory.
// Usage: node .agent/dist/cli/memory/init.js [--dir <path>] [--repo <slug>]
// Env: MEMORY_DIR, REPO_SLUG, GITHUB_REPOSITORY

import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolve } from "node:path";

import { ensureMemoryStructure } from "../../memory-artifacts.js";

const USAGE = [
  "Usage: memory/init.js [--dir <path>] [--repo <slug>]",
  "",
  "Options:",
  "  --dir <path>       Memory directory to initialize (defaults to MEMORY_DIR or cwd)",
  "  --repo <slug>      Repository slug used in seeded stubs (defaults to REPO_SLUG or GITHUB_REPOSITORY)",
  "  -h, --help         Show this message",
  "",
].join("\n");

interface WritableLike { write(chunk: string): void; }

export interface ParsedMemoryInitArgs {
  dir: string;
  repo: string;
  help: boolean;
}

const ARG_CONFIG = {
  options: {
    dir: { type: "string" },
    repo: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
  strict: true,
} as const satisfies ParseArgsConfig;

export function parseMemoryInitArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedMemoryInitArgs {
  const { values } = parseArgs({ ...ARG_CONFIG, args: argv });

  return {
    dir: (values.dir as string | undefined) || env.MEMORY_DIR || process.cwd(),
    repo: (values.repo as string | undefined) || env.REPO_SLUG || env.GITHUB_REPOSITORY || "",
    help: Boolean(values.help),
  };
}

export function runMemoryInitCli(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdout?: WritableLike;
    stderr?: WritableLike;
  } = {},
): number {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  let args: ParsedMemoryInitArgs;
  try {
    args = parseMemoryInitArgs(argv, env);
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
    stderr.write(`Missing or invalid repository slug (got: ${args.repo || "empty"}).\n\n${USAGE}`);
    return 1;
  }

  const rootDir = resolve(args.dir);
  const result = ensureMemoryStructure(rootDir, args.repo);
  stdout.write(
    `${JSON.stringify(
      {
        repo: args.repo,
        memoryDir: rootDir,
        createdFiles: result.createdFiles,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = runMemoryInitCli(process.argv.slice(2));
}
