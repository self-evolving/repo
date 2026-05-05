#!/usr/bin/env node

import { setOutput } from "../output.js";
import {
  DEFAULT_SEPO_VERSION_METADATA_PATH,
  formatSepoVersionSummary,
  readSepoVersionMetadata,
  type SepoVersionMetadata,
} from "../sepo-version.js";

interface Writable {
  write(chunk: string): void;
}

interface PrintSepoVersionIo {
  stdout: Writable;
  stderr: Writable;
}

const USAGE = `Usage: print-sepo-version [--path <metadata-json>] [--json]

Prints the installed Sepo version and source identity from .agent/sepo-version.json.
`;

function writeMetadataOutputs(metadata: SepoVersionMetadata): void {
  setOutput("schema_version", String(metadata.schema_version));
  setOutput("version", metadata.version);
  setOutput("channel", metadata.channel);
  setOutput("source_repo", metadata.source_repo);
  setOutput("source_ref", metadata.source_ref);
  setOutput("source_sha", metadata.source_sha || "");
  setOutput("installed_from", metadata.installed_from);
  setOutput("agent_files_hash", metadata.agent_files_hash || "");
  setOutput("summary", formatSepoVersionSummary(metadata));
}

export function runPrintSepoVersionCli(
  argv = process.argv.slice(2),
  io: PrintSepoVersionIo = { stdout: process.stdout, stderr: process.stderr },
): number {
  let metadataPath = DEFAULT_SEPO_VERSION_METADATA_PATH;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--path") {
      const next = argv[i + 1];
      if (!next) {
        io.stderr.write("Missing value for --path\n");
        return 2;
      }
      metadataPath = next;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      io.stdout.write(USAGE);
      return 0;
    }
    io.stderr.write(`Unknown argument: ${arg}\n${USAGE}`);
    return 2;
  }

  try {
    const metadata = readSepoVersionMetadata(metadataPath);
    writeMetadataOutputs(metadata);
    io.stdout.write(
      json
        ? `${JSON.stringify(metadata, null, 2)}\n`
        : `${formatSepoVersionSummary(metadata)}\n`,
    );
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr.write(`Failed to read Sepo version metadata: ${msg}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runPrintSepoVersionCli();
}
