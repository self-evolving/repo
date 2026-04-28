#!/usr/bin/env node

// CLI: fetch a discussion transcript via GitHub GraphQL.
// Usage: node .agent/dist/cli/fetch-discussion-transcript.js <discussion-number>
// Env: REPO_SLUG (optional, falls back to `gh repo view`)

import { execFileSync } from "node:child_process";

import {
  buildDiscussionTranscript,
  fetchDiscussionTranscript,
} from "../discussion-transcript.js";
import { createGhGraphqlClient, type GraphQLClient } from "../github-graphql.js";

const MAX_BUFFER = 16 * 1024 * 1024;
const USAGE = "Usage: fetch-discussion-transcript.js <discussion-number>\n";
const REPO_ERROR =
  "Could not determine repository. Set REPO_SLUG or run from a git checkout.\n";

type ExecGh = (
  file: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; maxBuffer: number },
) => string | Buffer;

interface WritableLike {
  write(chunk: string): void;
}

/**
 * Resolves the current repository slug from the environment or `gh repo view`.
 */
export function resolveRepoSlug(
  options: {
    env?: NodeJS.ProcessEnv;
    execGh?: ExecGh;
  } = {},
): string {
  const env = options.env || process.env;
  const execGh = options.execGh || execFileSync;
  const repoSlug = env.REPO_SLUG || "";
  if (repoSlug) {
    return repoSlug;
  }

  return execGh(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
    },
  )
    .toString("utf8")
    .trim();
}

/**
 * Parses the discussion number argument.
 */
export function parseDiscussionNumber(value: string | undefined): number | null {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  return number;
}

export function runFetchDiscussionTranscriptCli(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdout?: WritableLike;
    stderr?: WritableLike;
    resolveRepoSlug?: (options?: {
      env?: NodeJS.ProcessEnv;
      execGh?: ExecGh;
    }) => string;
    createClient?: () => GraphQLClient;
    fetchDiscussionTranscript?: typeof fetchDiscussionTranscript;
    buildDiscussionTranscript?: typeof buildDiscussionTranscript;
  } = {},
): number {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const number = parseDiscussionNumber(argv[0]);
  if (!number) {
    stderr.write(USAGE);
    return 1;
  }

  const resolveRepo = options.resolveRepoSlug || resolveRepoSlug;
  const repoSlug = resolveRepo({ env });
  const [owner, repo] = repoSlug.split("/", 2);
  if (!owner || !repo) {
    stderr.write(REPO_ERROR);
    return 1;
  }

  const createClient = options.createClient || createGhGraphqlClient;
  const fetchTranscript =
    options.fetchDiscussionTranscript || fetchDiscussionTranscript;
  const renderTranscript =
    options.buildDiscussionTranscript || buildDiscussionTranscript;

  try {
    const { discussionMeta, comments } = fetchTranscript(
      createClient(),
      owner,
      repo,
      number,
    );
    stdout.write(renderTranscript(discussionMeta, comments));
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runFetchDiscussionTranscriptCli(process.argv.slice(2));
}
