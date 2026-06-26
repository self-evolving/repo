#!/usr/bin/env node
// CLI: download one GitHub user attachment URL on demand for an agent run.

import {
  DEFAULT_GITHUB_ATTACHMENT_MAX_BYTES,
  DEFAULT_GITHUB_ATTACHMENT_TIMEOUT_MS,
  GitHubAttachmentDownloadError,
  downloadGitHubAttachment,
  resolveGitHubAttachmentOutputDir,
  resolveGitHubAttachmentToken,
  type GitHubAttachmentFetch,
} from "../github-attachment-download.js";

interface ParsedArgs {
  url: string;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: node .agent/dist/cli/download-github-attachment.js --url <github-user-attachment-url>",
    "",
    "Downloads only https://github.com/user-attachments/files/... or /assets/... URLs.",
    "Writes the file under $RUNNER_TEMP/agent-attachments and prints JSON metadata.",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { url: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new GitHubAttachmentDownloadError("Missing value for --url.", 2);
      }
      parsed.url = value;
      index += 1;
    } else {
      throw new GitHubAttachmentDownloadError(`Unknown argument: ${arg}`, 2);
    }
  }
  return parsed;
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GitHubAttachmentDownloadError(`${name} must be a positive integer.`, 2);
  }
  return parsed;
}

export async function runDownloadGitHubAttachmentCli(args: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  fetch?: GitHubAttachmentFetch;
  stdout?: Pick<typeof console, "log">;
  stderr?: Pick<typeof console, "error">;
} = {}): Promise<number> {
  const argv = args.argv || process.argv.slice(2);
  const env = args.env || process.env;
  const stdout = args.stdout || console;
  const stderr = args.stderr || console;

  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      stdout.log(usage());
      return 0;
    }
    if (!parsed.url) {
      throw new GitHubAttachmentDownloadError("Missing required --url argument.", 2);
    }

    const result = await downloadGitHubAttachment({
      url: parsed.url,
      outputDir: resolveGitHubAttachmentOutputDir(env),
      token: resolveGitHubAttachmentToken(env),
      fetch: args.fetch,
      maxBytes: parsePositiveIntegerEnv(
        env.GITHUB_ATTACHMENT_MAX_BYTES,
        DEFAULT_GITHUB_ATTACHMENT_MAX_BYTES,
        "GITHUB_ATTACHMENT_MAX_BYTES",
      ),
      timeoutMs: parsePositiveIntegerEnv(
        env.GITHUB_ATTACHMENT_TIMEOUT_MS,
        DEFAULT_GITHUB_ATTACHMENT_TIMEOUT_MS,
        "GITHUB_ATTACHMENT_TIMEOUT_MS",
      ),
    });

    stdout.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.error(`download-github-attachment failed: ${message}`);
    if (error instanceof GitHubAttachmentDownloadError) {
      return error.exitCode;
    }
    return 1;
  }
}

if (require.main === module) {
  runDownloadGitHubAttachmentCli().then((code) => {
    process.exitCode = code;
  });
}
