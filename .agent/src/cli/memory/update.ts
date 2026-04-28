#!/usr/bin/env node
// CLI: update agent memory files with validated bullet-level edits.
//
// Usage:
//   node .agent/dist/cli/memory/update.js add --file MEMORY.md --section Durable "<bullet>"
//   node .agent/dist/cli/memory/update.js replace --file MEMORY.md --section Durable --match "<text>" --with "<new bullet>"
//   node .agent/dist/cli/memory/update.js remove --file MEMORY.md --section Durable --match "<text>"
//   node .agent/dist/cli/memory/update.js daily-append "<bullet>"
//
// Env:
//   MEMORY_DIR  fallback for --dir when not passed explicitly

import { parseArgs, type ParseArgsConfig } from "node:util";

import {
  addBullet,
  appendDailyBullet,
  isEditableFile,
  removeBullet,
  replaceBullet,
  type EditableFile,
  type UpdateResult,
} from "../../memory-update.js";

const USAGE = [
  "Usage: memory/update.js <subcommand> [options] [text]",
  "",
  "Subcommands:",
  "  add --file <MEMORY.md|PROJECT.md> --section <name> <bullet>",
  "  replace --file <MEMORY.md|PROJECT.md> --section <name> --match <text> --with <new bullet>",
  "  remove --file <MEMORY.md|PROJECT.md> --section <name> --match <text>",
  "  daily-append <bullet>",
  "",
  "Global options:",
  "  --dir <path>   Memory directory (defaults to MEMORY_DIR or cwd)",
  "  -h, --help     Show this message",
].join("\n");

interface WritableLike { write(chunk: string): void; }

const SUBCOMMANDS = ["add", "replace", "remove", "daily-append"] as const;
type Subcommand = typeof SUBCOMMANDS[number];

interface ParsedArgs {
  subcommand: Subcommand | "";
  dir: string;
  file: EditableFile | "";
  section: string;
  match: string;
  withText: string;
  positional: string;
  help: boolean;
}

const ARG_CONFIG = {
  options: {
    dir: { type: "string" },
    file: { type: "string" },
    section: { type: "string" },
    match: { type: "string" },
    with: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
} as const satisfies ParseArgsConfig;

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

export function parseUpdateArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedArgs {
  const { values, positionals } = parseArgs({ ...ARG_CONFIG, args: argv });

  const file = values.file as string | undefined;
  if (file !== undefined && !isEditableFile(file)) {
    throw new Error(`--file must be MEMORY.md or PROJECT.md (got ${file})`);
  }

  let subcommand: Subcommand | "" = "";
  const rest = [...positionals];
  const first = rest.shift();
  if (first) {
    if (!isSubcommand(first)) {
      throw new Error(`Unknown subcommand: ${first}`);
    }
    subcommand = first;
  }

  return {
    subcommand,
    dir: (values.dir as string | undefined) || env.MEMORY_DIR || process.cwd(),
    file: (file as EditableFile | undefined) || "",
    section: (values.section as string | undefined) || "",
    match: (values.match as string | undefined) || "",
    withText: (values.with as string | undefined) || "",
    positional: rest.join(" ").trim(),
    help: Boolean(values.help),
  };
}

function describe(result: UpdateResult): { code: number; line: string } {
  switch (result.action.kind) {
    case "added":
      return { code: 0, line: `added bullet to ${result.file}` };
    case "deduped":
      return { code: 0, line: `collapsed duplicate bullet in ${result.file}` };
    case "replaced":
      return { code: 0, line: `replaced bullet in ${result.file}` };
    case "removed":
      return { code: 0, line: `removed bullet from ${result.file}` };
    case "noop":
      return { code: 0, line: `no change (duplicate): ${result.file}` };
    case "missing_section":
      return { code: 2, line: `section not found: ${result.action.section} in ${result.file}` };
    case "missing_match":
      return { code: 2, line: `no bullet matched: ${result.action.match} in ${result.file}` };
    case "ambiguous_match":
      return {
        code: 2,
        line: `multiple bullets matched: ${result.action.match} in ${result.file}\n${result.action.candidates.join("\n")}`,
      };
  }
}

export function runMemoryUpdateCli(
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

  let parsed: ParsedArgs;
  try {
    parsed = parseUpdateArgs(argv, env);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n\n${USAGE}\n`);
    return 1;
  }

  if (parsed.help || !parsed.subcommand) {
    stdout.write(`${USAGE}\n`);
    return parsed.help ? 0 : 1;
  }

  try {
    let result: UpdateResult;
    switch (parsed.subcommand) {
      case "add": {
        if (!parsed.file) throw new Error("--file is required for add");
        if (!parsed.section) throw new Error("--section is required for add");
        if (!parsed.positional) throw new Error("bullet text is required for add");
        result = addBullet(
          { root: parsed.dir, file: parsed.file, section: parsed.section },
          parsed.positional,
        );
        break;
      }
      case "replace": {
        if (!parsed.file) throw new Error("--file is required for replace");
        if (!parsed.section) throw new Error("--section is required for replace");
        if (!parsed.match) throw new Error("--match is required for replace");
        if (!parsed.withText) throw new Error("--with is required for replace");
        result = replaceBullet(
          { root: parsed.dir, file: parsed.file, section: parsed.section },
          parsed.match,
          parsed.withText,
        );
        break;
      }
      case "remove": {
        if (!parsed.file) throw new Error("--file is required for remove");
        if (!parsed.section) throw new Error("--section is required for remove");
        if (!parsed.match) throw new Error("--match is required for remove");
        result = removeBullet(
          { root: parsed.dir, file: parsed.file, section: parsed.section },
          parsed.match,
        );
        break;
      }
      case "daily-append": {
        if (!parsed.positional) throw new Error("bullet text is required for daily-append");
        result = appendDailyBullet(parsed.dir, parsed.positional);
        break;
      }
    }

    const { code, line } = describe(result);
    (code === 0 ? stdout : stderr).write(`${line}\n`);
    return code;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runMemoryUpdateCli(process.argv.slice(2));
}
