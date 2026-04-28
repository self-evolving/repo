#!/usr/bin/env node
// CLI: search agent memory files in a local directory.
// Usage: node .agent/dist/cli/memory/search.js [--dir <path>] [--limit <n>] [--snippets <n>] [--json] <query>
// Env: MEMORY_DIR (optional fallback for --dir)

import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolve } from "node:path";

import {
  formatMemorySearchResults,
  searchMemory,
  type MemorySearchResult,
} from "../../memory-search.js";

const USAGE = [
  "Usage: memory/search.js [--dir <path>] [--limit <n>] [--snippets <n>] [--json] <query>",
  "",
  "Options:",
  "  --dir <path>       Memory directory to search (defaults to MEMORY_DIR or cwd)",
  "  --limit <n>        Maximum number of files to return (default: 5)",
  "  --snippets <n>     Maximum snippets per file (default: 3)",
  "  --json             Emit machine-readable JSON instead of text",
  "  -h, --help         Show this message",
  "",
].join("\n");

interface WritableLike { write(chunk: string): void; }

export interface ParsedMemorySearchArgs {
  query: string;
  dir: string;
  limit: number;
  snippets: number;
  json: boolean;
  help: boolean;
}

const ARG_CONFIG = {
  options: {
    dir: { type: "string" },
    limit: { type: "string" },
    snippets: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
} as const satisfies ParseArgsConfig;

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

export function parseMemorySearchArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedMemorySearchArgs {
  const { values, positionals } = parseArgs({ ...ARG_CONFIG, args: argv });

  const dir = (values.dir as string | undefined) || env.MEMORY_DIR || "";
  const limit = values.limit !== undefined
    ? parsePositiveInteger(values.limit as string, "--limit")
    : 5;
  const snippets = values.snippets !== undefined
    ? parsePositiveInteger(values.snippets as string, "--snippets")
    : 3;

  return {
    query: positionals.join(" ").trim() || env.MEMORY_QUERY || "",
    dir: dir || process.cwd(),
    limit,
    snippets,
    json: Boolean(values.json),
    help: Boolean(values.help),
  };
}

function serializeJson(query: string, dir: string, results: MemorySearchResult[]): string {
  return `${JSON.stringify(
    {
      query,
      memoryDir: resolve(dir),
      resultCount: results.length,
      results,
    },
    null,
    2,
  )}\n`;
}

export function runMemorySearchCli(
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

  let args: ParsedMemorySearchArgs;
  try {
    args = parseMemorySearchArgs(argv, env);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n\n${USAGE}`);
    return 1;
  }

  if (args.help) { stdout.write(USAGE); return 0; }
  if (!args.query) {
    stderr.write(`Missing search query.\n\n${USAGE}`);
    return 1;
  }

  try {
    const results = searchMemory(args.query, {
      rootDir: args.dir,
      limit: args.limit,
      snippetsPerFile: args.snippets,
    });

    if (args.json) {
      stdout.write(serializeJson(args.query, args.dir, results));
    } else {
      stdout.write(formatMemorySearchResults(args.query, results, args.dir));
    }
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runMemorySearchCli(process.argv.slice(2));
}
