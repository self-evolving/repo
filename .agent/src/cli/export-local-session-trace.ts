#!/usr/bin/env node

// CLI: export a local agent transcript as a versioned, sanitized trace.

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
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

type InputChunkReader = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;

const INPUT_READ_CHUNK_BYTES = 64 * 1024;

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

function inputLimitError(maxBytes: number): LocalSessionTraceError {
  return new LocalSessionTraceError(
    `Local-session input exceeds ${maxBytes} bytes.`,
  );
}

function readBoundedInput(
  path: string,
  maxBytes: number,
  readChunk: InputChunkReader,
): Uint8Array {
  if (path !== "-") {
    const stats = statSync(path);
    if (stats.isFile() && stats.size > maxBytes) throw inputLimitError(maxBytes);
  }

  const fd = path === "-" ? 0 : openSync(path, "r");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(INPUT_READ_CHUNK_BYTES, maxBytes + 1));
  let totalBytes = 0;

  try {
    while (true) {
      const bytesToRead = Math.min(buffer.byteLength, maxBytes - totalBytes + 1);
      const bytesRead = readChunk(fd, buffer, 0, bytesToRead);
      if (
        !Number.isSafeInteger(bytesRead)
        || bytesRead < 0
        || bytesRead > bytesToRead
      ) {
        throw new LocalSessionTraceError("Could not read local-session input safely.");
      }
      if (bytesRead === 0) break;
      if (totalBytes + bytesRead > maxBytes) throw inputLimitError(maxBytes);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
  } finally {
    if (path !== "-") closeSync(fd);
  }

  return Buffer.concat(chunks, totalBytes);
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
  maxInputBytes?: number;
  readInput?: (path: string) => Uint8Array;
  readInputChunk?: InputChunkReader;
  writeOutput?: (path: string, content: string) => void;
  outputExists?: (path: string) => boolean;
} = {}): number {
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const outputExists = options.outputExists || existsSync;
  const maxInputBytes = options.maxInputBytes
    ?? DEFAULT_LOCAL_SESSION_TRACE_MAX_INPUT_BYTES;
  const readChunk = options.readInputChunk || ((
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => readSync(fd, buffer, offset, length, null));

  try {
    if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) {
      throw new LocalSessionTraceError("Local-session input limit must be a positive integer.");
    }
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

    const input = options.readInput
      ? options.readInput(parsed.input)
      : readBoundedInput(parsed.input, maxInputBytes, readChunk);
    if (input.byteLength > maxInputBytes) throw inputLimitError(maxInputBytes);
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
