#!/usr/bin/env node

// CLI: fetch target context for explicit non-issue /implement metadata.
// Usage: node .agent/dist/cli/prepare-implement-metadata-context.js
// Env: REPO_SLUG, TARGET_KIND, TARGET_NUMBER, TARGET_CONTEXT_FILE

import { writeFileSync } from "node:fs";

import { buildDiscussionTranscript, fetchDiscussionTranscript } from "../discussion-transcript.js";
import { gh } from "../github.js";
import { createGhGraphqlClient, type GraphQLClient } from "../github-graphql.js";
import { setOutput } from "../output.js";

const PR_VIEW_FIELDS = [
  "title",
  "body",
  "author",
  "comments",
  "files",
  "labels",
  "reviews",
  "reviewDecision",
  "state",
  "url",
].join(",");

interface WritableLike {
  write(chunk: string): void;
}

export function renderPullRequestContext(raw: string): string {
  const parsed = JSON.parse(raw) as unknown;
  return [
    "## Target Pull Request Context",
    "",
    "```json",
    JSON.stringify(parsed, null, 2),
    "```",
    "",
  ].join("\n");
}

export function fetchPullRequestContext(repoSlug: string, targetNumber: number): string {
  const raw = gh([
    "pr",
    "view",
    String(targetNumber),
    "--repo",
    repoSlug,
    "--json",
    PR_VIEW_FIELDS,
  ]);
  return renderPullRequestContext(raw);
}

export function fetchDiscussionContext(options: {
  repoSlug: string;
  targetNumber: number;
  createClient?: () => GraphQLClient;
  fetchDiscussionTranscript?: typeof fetchDiscussionTranscript;
  buildDiscussionTranscript?: typeof buildDiscussionTranscript;
}): string {
  const [owner, repo] = options.repoSlug.split("/", 2);
  if (!owner || !repo) {
    throw new Error("REPO_SLUG must be in owner/repo form");
  }

  const createClient = options.createClient || createGhGraphqlClient;
  const fetchTranscript = options.fetchDiscussionTranscript || fetchDiscussionTranscript;
  const renderTranscript = options.buildDiscussionTranscript || buildDiscussionTranscript;
  const { discussionMeta, comments } = fetchTranscript(createClient(), owner, repo, options.targetNumber);
  return renderTranscript(discussionMeta, comments);
}

export function runPrepareImplementMetadataContextCli(options: {
  env?: NodeJS.ProcessEnv;
  stdout?: WritableLike;
  stderr?: WritableLike;
  fetchPullRequestContext?: typeof fetchPullRequestContext;
  fetchDiscussionContext?: typeof fetchDiscussionContext;
} = {}): number {
  const env = options.env || process.env;
  const stderr = options.stderr || process.stderr;
  const repoSlug = String(env.REPO_SLUG || "").trim();
  const targetKind = String(env.TARGET_KIND || "").trim();
  const targetNumber = Number(env.TARGET_NUMBER || "");
  const outputFile = String(env.TARGET_CONTEXT_FILE || "").trim();

  if (!repoSlug) {
    stderr.write("REPO_SLUG is required\n");
    return 1;
  }
  if (!Number.isInteger(targetNumber) || targetNumber <= 0) {
    stderr.write("TARGET_NUMBER must be a positive integer\n");
    return 1;
  }
  if (!outputFile) {
    stderr.write("TARGET_CONTEXT_FILE is required\n");
    return 1;
  }

  try {
    const context =
      targetKind === "pull_request"
        ? (options.fetchPullRequestContext || fetchPullRequestContext)(repoSlug, targetNumber)
        : targetKind === "discussion"
          ? (options.fetchDiscussionContext || fetchDiscussionContext)({ repoSlug, targetNumber })
          : "";

    if (!context) {
      throw new Error(`Unsupported target kind for implement metadata context: ${targetKind || "(missing)"}`);
    }

    writeFileSync(outputFile, context, "utf8");
    setOutput("context_file", outputFile);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runPrepareImplementMetadataContextCli();
}
