import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  inferLocalSessionOutputFormat,
  runExportLocalSessionTraceCli,
} from "../cli/export-local-session-trace.js";

function createBufferWriter(): {
  writer: { write(chunk: string): void };
  read(): string;
} {
  let output = "";
  return {
    writer: {
      write(chunk: string) {
        output += chunk;
      },
    },
    read() {
      return output;
    },
  };
}

const now = () => new Date("2026-08-03T12:34:56.000Z");

test("export CLI renders sanitized JSON to stdout", () => {
  const stdout = createBufferWriter();
  const stderr = createBufferWriter();
  const code = runExportLocalSessionTraceCli({
    argv: ["--input", "session.md", "--provider", "codex"],
    stdout: stdout.writer,
    stderr: stderr.writer,
    now,
    readInput() {
      return Buffer.from(
        "## User\nQuestion TOKEN: abcdefghijklmnop\n\n## Assistant\nAnswer",
      );
    },
  });

  assert.equal(code, 0);
  assert.equal(stderr.read(), "");
  const trace = JSON.parse(stdout.read()) as {
    schema_version: number;
    provenance: { source_format: string; provider: string };
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(trace.schema_version, 1);
  assert.deepEqual(trace.provenance, {
    source_format: "markdown",
    provider: "codex",
  });
  assert.deepEqual(trace.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(stdout.read().includes("abcdefghijklmnop"), false);
});

test("export CLI infers JSONL output from the destination and writes it", () => {
  const stdout = createBufferWriter();
  const stderr = createBufferWriter();
  let writtenPath = "";
  let writtenContent = "";
  const code = runExportLocalSessionTraceCli({
    argv: ["--input", "session.txt", "--output", "safe-trace.jsonl"],
    stdout: stdout.writer,
    stderr: stderr.writer,
    now,
    readInput() {
      return Buffer.from("User: Question\nAssistant: Answer");
    },
    outputExists() {
      return false;
    },
    writeOutput(path, content) {
      writtenPath = path;
      writtenContent = content;
    },
  });

  assert.equal(code, 0);
  assert.equal(stdout.read(), "");
  assert.equal(stderr.read(), "");
  assert.equal(writtenPath, "safe-trace.jsonl");
  const records = writtenContent.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records[0].record_type, "trace");
  assert.deepEqual(records.slice(1).map((record) => record.record_type), [
    "message",
    "message",
  ]);
});

test("export CLI refuses archive input and existing or in-place output", () => {
  const archiveError = createBufferWriter();
  const archiveCode = runExportLocalSessionTraceCli({
    argv: ["--input", "session.zip"],
    stdout: createBufferWriter().writer,
    stderr: archiveError.writer,
    readInput() {
      return Buffer.from("not actually an archive");
    },
  });
  assert.equal(archiveCode, 1);
  assert.match(archiveError.read(), /Archive inputs are not supported/);

  const existingError = createBufferWriter();
  let read = false;
  const existingCode = runExportLocalSessionTraceCli({
    argv: ["--input", "session.txt", "--output", "trace.json"],
    stdout: createBufferWriter().writer,
    stderr: existingError.writer,
    outputExists() {
      return true;
    },
    readInput() {
      read = true;
      return Buffer.from("Question");
    },
  });
  assert.equal(existingCode, 1);
  assert.equal(read, false);
  assert.match(existingError.read(), /already exists/);

  const inPlaceError = createBufferWriter();
  const inPlaceCode = runExportLocalSessionTraceCli({
    argv: ["--input", "session.txt", "--output", "session.txt", "--force"],
    stdout: createBufferWriter().writer,
    stderr: inPlaceError.writer,
  });
  assert.equal(inPlaceCode, 2);
  assert.match(inPlaceError.read(), /Input and output paths must be different/);
});

test("export CLI rejects an oversized regular file during size preflight", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "local-session-export-"));
  const inputPath = join(tempDir, "session.txt");
  writeFileSync(inputPath, "123456789");

  try {
    const stderr = createBufferWriter();
    const code = runExportLocalSessionTraceCli({
      argv: ["--input", inputPath],
      stdout: createBufferWriter().writer,
      stderr: stderr.writer,
      maxInputBytes: 8,
    });

    assert.equal(code, 1);
    assert.match(stderr.read(), /Local-session input exceeds 8 bytes/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("export CLI stops reading stdin after the first over-limit byte", () => {
  const source = Buffer.from("User: this input is too large");
  const stderr = createBufferWriter();
  let sourceOffset = 0;
  const code = runExportLocalSessionTraceCli({
    argv: ["--input", "-"],
    stdout: createBufferWriter().writer,
    stderr: stderr.writer,
    maxInputBytes: 8,
    readInputChunk(_fd, buffer, offset, length) {
      const chunk = source.subarray(sourceOffset, sourceOffset + length);
      buffer.set(chunk, offset);
      sourceOffset += chunk.byteLength;
      return chunk.byteLength;
    },
  });

  assert.equal(code, 1);
  assert.equal(sourceOffset, 9);
  assert.match(stderr.read(), /Local-session input exceeds 8 bytes/);
});

test("export CLI validates arguments and supports help", () => {
  const help = createBufferWriter();
  assert.equal(runExportLocalSessionTraceCli({
    argv: ["--help"],
    stdout: help.writer,
    stderr: createBufferWriter().writer,
  }), 0);
  assert.match(help.read(), /Only user\/assistant text is exported/);

  const missing = createBufferWriter();
  assert.equal(runExportLocalSessionTraceCli({
    argv: [],
    stdout: createBufferWriter().writer,
    stderr: missing.writer,
  }), 2);
  assert.match(missing.read(), /Missing required --input/);

  const invalid = createBufferWriter();
  assert.equal(runExportLocalSessionTraceCli({
    argv: ["--input", "session.txt", "--output-format", "yaml"],
    stdout: createBufferWriter().writer,
    stderr: invalid.writer,
  }), 2);
  assert.match(invalid.read(), /--output-format must be json or jsonl/);
});

test("output format inference prefers an explicit format", () => {
  assert.equal(inferLocalSessionOutputFormat("trace.jsonl", ""), "jsonl");
  assert.equal(inferLocalSessionOutputFormat("trace.ndjson", ""), "jsonl");
  assert.equal(inferLocalSessionOutputFormat("trace.json", ""), "json");
  assert.equal(inferLocalSessionOutputFormat("trace.jsonl", "json"), "json");
});
