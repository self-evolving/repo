#!/usr/bin/env node

// CLI: export a local agent transcript as a versioned, sanitized trace.

import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, resolve } from "node:path";

import {
  assertSupportedLocalSessionInput,
  DEFAULT_LOCAL_SESSION_TRACE_MAX_INPUT_BYTES,
  LocalSessionTraceError,
  parseLocalSessionTrace,
  serializeLocalSessionTrace,
  type LocalSessionInputFormat,
  type LocalSessionOutputFormat,
} from "../local-session-trace.js";

interface WritableLike {
  write(chunk: string): void;
}

interface ParsedArgs {
  input: string;
  output: string;
  inputFormat: LocalSessionInputFormat;
  outputFormat: LocalSessionOutputFormat | "";
  provider: string;
  force: boolean;
  help: boolean;
}

class LocalSessionExportCliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = "LocalSessionExportCliError";
  }
}

function usage(): string {
  return [
    "Usage: node .agent/dist/cli/export-local-session-trace.js --input <path|-> [options]",
    "",
    "Options:",
    "  --output <path>           Write to a file instead of stdout",
    "  --input-format <format>   auto, json, jsonl, markdown, or text (default: auto)",
    "  --output-format <format>  json or jsonl (default: inferred from output path, then json)",
    "  --provider <name>         Add minimal provider provenance (for example codex or claude)",
    "  --force                   Replace an existing output file",
    "  --help                    Show this help",
    "",
    "Only user/assistant text is exported. Archives and binary inputs are rejected.",
  ].join("\n");
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new LocalSessionExportCliError(`Missing value for ${flag}.`, 2);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    input: "",
    output: "",
    inputFormat: "auto",
    outputFormat: "",
    provider: "",
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--input") {
      parsed.input = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--output") {
      parsed.output = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--input-format") {
      const value = requiredValue(argv, index, arg);
      if (!["auto", "json", "jsonl", "markdown", "text"].includes(value)) {
        throw new LocalSessionExportCliError(
          "--input-format must be auto, json, jsonl, markdown, or text.",
          2,
        );
      }
      parsed.inputFormat = value as LocalSessionInputFormat;
      index += 1;
    } else if (arg === "--output-format") {
      const value = requiredValue(argv, index, arg);
      if (value !== "json" && value !== "jsonl") {
        throw new LocalSessionExportCliError(
          "--output-format must be json or jsonl.",
          2,
        );
      }
      parsed.outputFormat = value;
      index += 1;
    } else if (arg === "--provider") {
      parsed.provider = requiredValue(argv, index, arg);
      index += 1;
    } else {
      throw new LocalSessionExportCliError(`Unknown argument: ${arg}`, 2);
    }
  }
  return parsed;
}

function pathsReferToSameFile(input: string, output: string): boolean {
  if (resolve(input) === resolve(output)) return true;
  if (!existsSync(input) || !existsSync(output)) return false;
  try {
    const inputStat = statSync(input);
    const outputStat = statSync(output);
    return inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino;
  } catch {
    return false;
  }
}

export function inferLocalSessionOutputFormat(
  outputPath: string,
  explicitFormat: LocalSessionOutputFormat | "",
): LocalSessionOutputFormat {
  if (explicitFormat) return explicitFormat;
  const extension = extname(outputPath).toLowerCase();
  return extension === ".jsonl" || extension === ".ndjson" ? "jsonl" : "json";
}

export function runExportLocalSessionTraceCli(options: {
  argv?: string[];
  stdout?: WritableLike;
  stderr?: WritableLike;
  now?: () => Date;
  readInput?: (path: string) => Uint8Array;
  writeOutput?: (path: string, content: string) => void;
  outputExists?: (path: string) => boolean;
} = {}): number {
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const readInput = options.readInput || ((path: string) =>
    path === "-" ? readFileSync(0) : readFileSync(path));
  const outputExists = options.outputExists || existsSync;

  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    if (!parsed.input) {
      throw new LocalSessionExportCliError("Missing required --input argument.", 2);
    }
    if (
      parsed.input !== "-"
      && parsed.output
      && pathsReferToSameFile(parsed.input, parsed.output)
    ) {
      throw new LocalSessionExportCliError(
        "Input and output paths must be different; keep the original transcript unchanged.",
        2,
      );
    }
    if (parsed.output && outputExists(parsed.output) && !parsed.force) {
      throw new LocalSessionExportCliError(
        `Output file already exists: ${parsed.output}. Pass --force to replace it.`,
        1,
      );
    }

    const input = readInput(parsed.input);
    if (input.byteLength > DEFAULT_LOCAL_SESSION_TRACE_MAX_INPUT_BYTES) {
      throw new LocalSessionTraceError(
        `Local-session input exceeds ${DEFAULT_LOCAL_SESSION_TRACE_MAX_INPUT_BYTES} bytes.`,
      );
    }
    assertSupportedLocalSessionInput(parsed.input === "-" ? "stdin" : parsed.input, input);
    const source = Buffer.from(input).toString("utf8");
    const trace = parseLocalSessionTrace(source, {
      inputFormat: parsed.inputFormat,
      sourceName: parsed.input === "-" ? "" : parsed.input,
      provider: parsed.provider,
      now: options.now,
    });
    const outputFormat = inferLocalSessionOutputFormat(
      parsed.output,
      parsed.outputFormat,
    );
    const serialized = serializeLocalSessionTrace(trace, outputFormat);

    if (parsed.output) {
      if (options.writeOutput) {
        options.writeOutput(parsed.output, serialized);
      } else {
        writeFileSync(parsed.output, serialized, {
          encoding: "utf8",
          flag: parsed.force ? "w" : "wx",
        });
      }
    } else {
      stdout.write(serialized);
    }
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`export-local-session-trace failed: ${message}\n`);
    if (error instanceof LocalSessionExportCliError) return error.exitCode;
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runExportLocalSessionTraceCli();
}
