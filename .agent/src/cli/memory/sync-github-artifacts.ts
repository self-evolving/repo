#!/usr/bin/env node
// CLI: mirror issues / pull requests / discussions into the memory
// branch's github/ subtree as raw `gh --json` output. No LLM, no custom
// formatting — the agent grep-searches / jq-queries the JSON dumps directly.
//
// Emits cursors as step outputs so the outer workflow can persist them via
// write-sync-state.

import { execFileSync } from "node:child_process";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolve } from "node:path";

import { createGhGraphqlClient, type GraphQLClient } from "../../github-graphql.js";
import {
  discussionArtifactPath,
  ensureMemoryStructure,
  issueArtifactPath,
  pullRequestArtifactPath,
  writeFileIfChanged,
} from "../../memory-artifacts.js";
import { setOutput } from "../../output.js";

const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_LOOKBACK_DAYS = 30;

// Fields requested from `gh issue view` / `gh pr view`. We persist whatever
// gh gives us back verbatim.
const ISSUE_FIELDS = [
  "number", "title", "body", "url", "state", "author", "labels",
  "createdAt", "updatedAt", "closedAt", "comments",
].join(",");

const PR_FIELDS = [
  "number", "title", "body", "url", "state", "author", "labels",
  "createdAt", "updatedAt", "closedAt", "mergedAt", "reviewDecision",
  "headRefName", "baseRefName", "comments", "reviews", "files",
].join(",");

interface WritableLike { write(chunk: string): void; }

interface Args {
  dir: string;
  repo: string;
  since: string;
  startedAt: string;
  lookbackDays: number;
}

interface IssueListItem {
  number: number;
  updated_at?: string;
  pull_request?: unknown;
}

interface DiscussionNode {
  number: number;
  updatedAt?: string | null;
}

interface DiscussionAuthorRecord {
  login?: string | null;
}

interface DiscussionReplyRecord {
  id: string;
  body?: string | null;
  createdAt?: string | null;
  url?: string | null;
  author?: DiscussionAuthorRecord | null;
  replyTo?: { id?: string | null } | null;
}

interface DiscussionCommentRecord extends DiscussionReplyRecord {
  replies?: {
    nodes?: DiscussionReplyRecord[];
    pageInfo?: {
      hasNextPage?: boolean | null;
      endCursor?: string | null;
    } | null;
  } | null;
}

interface DiscussionPagePayload {
  repository?: {
    discussion?: {
      number?: number | null;
      title?: string | null;
      url?: string | null;
      body?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      author?: DiscussionAuthorRecord | null;
      category?: { name?: string | null } | null;
      comments?: {
        nodes?: DiscussionCommentRecord[];
        pageInfo?: {
          hasNextPage?: boolean | null;
          endCursor?: string | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

interface DiscussionReplyPagePayload {
  node?: {
    replies?: {
      nodes?: DiscussionReplyRecord[];
      pageInfo?: {
        hasNextPage?: boolean | null;
        endCursor?: string | null;
      } | null;
    } | null;
  } | null;
}

interface DiscussionMirrorReply {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  author: { login: string } | null;
  replyTo: { id: string } | null;
}

interface DiscussionMirrorComment {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  author: { login: string } | null;
  replies: {
    nodes: DiscussionMirrorReply[];
    pageInfo: { hasNextPage: false; endCursor: null };
  };
}

interface DiscussionMirrorDetail {
  number: number;
  title: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  category: { name: string } | null;
  comments: {
    nodes: DiscussionMirrorComment[];
    pageInfo: { hasNextPage: false; endCursor: null };
  };
}

const ARG_CONFIG = {
  options: {
    dir: { type: "string" },
    repo: { type: "string" },
    since: { type: "string" },
    "started-at": { type: "string" },
    "lookback-days": { type: "string" },
  },
  allowPositionals: false,
  strict: true,
} as const satisfies ParseArgsConfig;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? "");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const { values } = parseArgs({ ...ARG_CONFIG, args: argv });
  const dir = (values.dir as string | undefined) || env.MEMORY_DIR || process.cwd();
  const repo = (values.repo as string | undefined) || env.REPO_SLUG || env.GITHUB_REPOSITORY || "";
  const startedAt = (values["started-at"] as string | undefined) || env.MEMORY_SYNC_STARTED_AT || new Date().toISOString();
  const lookbackDays = parsePositiveInt(
    (values["lookback-days"] as string | undefined) || env.MEMORY_SYNC_LOOKBACK_DAYS,
    DEFAULT_LOOKBACK_DAYS,
  );
  const explicitSince = (values.since as string | undefined) || env.MEMORY_SYNC_SINCE || "";
  const since = explicitSince || isoDaysAgo(startedAt, lookbackDays);

  return { dir: resolve(dir), repo, since, startedAt, lookbackDays };
}

function isoDaysAgo(fromIso: string, days: number): string {
  return new Date(new Date(fromIso).getTime() - days * 86_400_000).toISOString();
}

function maxIso(a: string, b: string | undefined | null): string {
  if (!b) return a;
  return a >= b ? a : b;
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(
    execFileSync("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
    }).toString("utf8"),
  ) as T;
}

export function buildGhApiPagedArgs(endpoint: string, params: Array<[string, string]>): string[] {
  const args = ["api", "--method", "GET", "--paginate", "--slurp", endpoint];
  for (const [flag, value] of params) args.push(flag, value);
  return args;
}

function ghApiPaged<T>(endpoint: string, params: Array<[string, string]>): T[] {
  const args = buildGhApiPagedArgs(endpoint, params);
  return ghJson<T[][]>(args).flat();
}

function writeArtifact(path: string, data: unknown): boolean {
  return writeFileIfChanged(path, JSON.stringify(data, null, 2) + "\n");
}

export function hasDiscussionsEnabled(
  client: GraphQLClient,
  owner: string,
  repo: string,
): boolean {
  const data = client.graphql<{
    repository?: { hasDiscussionsEnabled?: boolean | null } | null;
  }>(
    `query($owner:String!,$repo:String!){
      repository(owner:$owner,name:$repo){
        hasDiscussionsEnabled
      }
    }`,
    { owner, repo },
  );

  return data.repository?.hasDiscussionsEnabled === true;
}

export function fetchDiscussions(
  client: GraphQLClient,
  owner: string,
  repo: string,
  since: string,
): DiscussionNode[] {
  if (!hasDiscussionsEnabled(client, owner, repo)) {
    return [];
  }

  const out: DiscussionNode[] = [];
  let after: string | undefined;

  while (true) {
    const page = client.graphql<{
      repository?: {
        discussions?: {
          nodes?: DiscussionNode[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
        } | null;
      } | null;
    }>(
      `query($owner:String!,$repo:String!,$after:String){
        repository(owner:$owner,name:$repo){
          discussions(first:100, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
            nodes { number updatedAt }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { owner, repo, after },
    );

    const nodes = page.repository?.discussions?.nodes ?? [];
    let reachedOlder = false;
    for (const node of nodes) {
      if (since && node.updatedAt && node.updatedAt <= since) {
        reachedOlder = true;
        break;
      }
      out.push(node);
    }
    if (reachedOlder) break;

    const info = page.repository?.discussions?.pageInfo;
    if (!info?.hasNextPage) break;
    after = info.endCursor || undefined;
  }

  return out;
}

function fetchPaginatedDiscussionDetail(
  client: GraphQLClient,
  owner: string,
  repo: string,
  number: number,
): unknown {
  let detail: DiscussionMirrorDetail | null = null;
  const comments: DiscussionMirrorComment[] = [];
  let after: string | undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = client.graphql<DiscussionPagePayload>(
      `query($owner:String!,$repo:String!,$n:Int!,$after:String){
        repository(owner:$owner,name:$repo){
          discussion(number:$n){
            number title url body createdAt updatedAt
            author { login }
            category { name }
            comments(first:100, after:$after) {
              nodes {
                id body createdAt url
                author { login }
                replies(first:100) {
                  nodes {
                    id body createdAt url
                    author { login }
                    replyTo { id }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { owner, repo, n: number, after },
    );

    const discussion = data.repository?.discussion;
    if (!discussion) return null;

    if (!detail) {
      detail = {
        number: discussion.number ?? number,
        title: discussion.title || "",
        url: discussion.url || "",
        body: discussion.body || "",
        createdAt: discussion.createdAt || "",
        updatedAt: discussion.updatedAt || "",
        author: discussion.author?.login ? { login: discussion.author.login } : null,
        category: discussion.category?.name ? { name: discussion.category.name } : null,
        comments: {
          nodes: comments,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }

    for (const rawComment of discussion.comments?.nodes || []) {
      const replies = (rawComment.replies?.nodes || []).map((reply) => ({
        id: reply.id,
        body: reply.body || "",
        createdAt: reply.createdAt || "",
        url: reply.url || "",
        author: reply.author?.login ? { login: reply.author.login } : null,
        replyTo: reply.replyTo?.id ? { id: reply.replyTo.id } : null,
      }));

      let replyAfter = rawComment.replies?.pageInfo?.endCursor || undefined;
      let replyHasNextPage = rawComment.replies?.pageInfo?.hasNextPage || false;

      while (replyHasNextPage) {
        const replyPage = client.graphql<DiscussionReplyPagePayload>(
          `query($commentId:ID!,$after:String){
            node(id:$commentId){
              ... on DiscussionComment {
                replies(first:100, after:$after) {
                  nodes {
                    id body createdAt url
                    author { login }
                    replyTo { id }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
          { commentId: rawComment.id, after: replyAfter },
        );

        const moreReplies = replyPage.node?.replies;
        if (!moreReplies) break;

        replies.push(
          ...(moreReplies.nodes || []).map((reply) => ({
            id: reply.id,
            body: reply.body || "",
            createdAt: reply.createdAt || "",
            url: reply.url || "",
            author: reply.author?.login ? { login: reply.author.login } : null,
            replyTo: reply.replyTo?.id ? { id: reply.replyTo.id } : null,
          })),
        );
        replyAfter = moreReplies.pageInfo?.endCursor || undefined;
        replyHasNextPage = moreReplies.pageInfo?.hasNextPage || false;
      }

      comments.push({
        id: rawComment.id,
        body: rawComment.body || "",
        createdAt: rawComment.createdAt || "",
        url: rawComment.url || "",
        author: rawComment.author?.login ? { login: rawComment.author.login } : null,
        replies: {
          nodes: replies,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    }

    after = discussion.comments?.pageInfo?.endCursor || undefined;
    hasNextPage = discussion.comments?.pageInfo?.hasNextPage || false;
  }

  return detail;
}

export function fetchDiscussionDetail(
  client: GraphQLClient,
  owner: string,
  repo: string,
  number: number,
): unknown {
  return fetchPaginatedDiscussionDetail(client, owner, repo, number);
}

export function runSyncGithubArtifactsCli(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdout?: WritableLike;
    stderr?: WritableLike;
    graphqlClient?: GraphQLClient;
  } = {},
): number {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  let args: Args;
  try {
    args = parseCliArgs(argv, env);
  } catch (error: unknown) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (!args.repo || !args.repo.includes("/")) {
    stderr.write(`Missing or invalid repository slug (got: ${args.repo || "empty"}). Set REPO_SLUG or GITHUB_REPOSITORY.\n`);
    return 1;
  }

  const [owner, repoName] = args.repo.split("/", 2) as [string, string];

  try {
    ensureMemoryStructure(args.dir, args.repo);

    // Issues + PRs come from one REST endpoint; the `pull_request` marker
    // distinguishes them.
    const issueLike = ghApiPaged<IssueListItem>(`repos/${args.repo}/issues`, [
      ["-f", "state=all"],
      ["-f", `since=${args.since}`],
      ["-f", "sort=updated"],
      ["-f", "direction=asc"],
      ["-F", "per_page=100"],
    ]);
    const issueItems = issueLike.filter((i) => !i.pull_request);
    const pullItems = issueLike.filter((i) => Boolean(i.pull_request));

    let changed = 0;
    let issueCursor = args.startedAt;
    let pullCursor = args.startedAt;
    let lastActivityAt = "";

    for (const item of issueItems) {
      const data = ghJson<{ updatedAt?: string }>([
        "issue", "view", String(item.number), "--repo", args.repo, "--json", ISSUE_FIELDS,
      ]);
      if (writeArtifact(issueArtifactPath(args.dir, item.number), data)) changed += 1;
      issueCursor = maxIso(issueCursor, item.updated_at || data.updatedAt);
      lastActivityAt = maxIso(lastActivityAt, item.updated_at || data.updatedAt);
    }

    for (const item of pullItems) {
      const data = ghJson<{ updatedAt?: string }>([
        "pr", "view", String(item.number), "--repo", args.repo, "--json", PR_FIELDS,
      ]);
      if (writeArtifact(pullRequestArtifactPath(args.dir, item.number), data)) changed += 1;
      pullCursor = maxIso(pullCursor, item.updated_at || data.updatedAt);
      lastActivityAt = maxIso(lastActivityAt, item.updated_at || data.updatedAt);
    }

    // Discussions: no `gh discussion` subcommand (cli/cli#3164) — use GraphQL.
    const client = options.graphqlClient || createGhGraphqlClient();
    const discussionNodes = fetchDiscussions(client, owner, repoName, args.since);
    let discussionCursor = args.startedAt;

    for (const node of discussionNodes) {
      const detail = fetchDiscussionDetail(client, owner, repoName, node.number);
      if (writeArtifact(discussionArtifactPath(args.dir, node.number), detail)) changed += 1;
      discussionCursor = maxIso(discussionCursor, node.updatedAt);
      lastActivityAt = maxIso(lastActivityAt, node.updatedAt);
    }

    // Compatibility-only: commit artifacts are no longer mirrored, but the
    // workflows still pass these outputs into the sync-state writer.
    const commitCursor = args.startedAt;

    setOutput("effective_since", args.since);
    setOutput("issue_count", String(issueItems.length));
    setOutput("pull_count", String(pullItems.length));
    setOutput("discussion_count", String(discussionNodes.length));
    setOutput("commit_count", "0");
    setOutput("changed_files", String(changed));
    setOutput("last_activity_at", lastActivityAt);
    setOutput("issue_cursor", issueCursor);
    setOutput("pull_cursor", pullCursor);
    setOutput("discussion_cursor", discussionCursor);
    setOutput("commit_cursor", commitCursor);

    stdout.write(
      `${JSON.stringify(
        {
          repo: args.repo,
          memoryDir: args.dir,
          effectiveSince: args.since,
          issueCount: issueItems.length,
          pullCount: pullItems.length,
          discussionCount: discussionNodes.length,
          commitCount: 0,
          changedFiles: changed,
          cursors: {
            issues: issueCursor,
            pulls: pullCursor,
            discussions: discussionCursor,
            commits: commitCursor,
          },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error: unknown) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runSyncGithubArtifactsCli(process.argv.slice(2));
}
