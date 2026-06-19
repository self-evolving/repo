import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  fetchDiscussionTranscript,
  type DiscussionTranscriptComment,
  type DiscussionTranscriptReply,
} from "./discussion-transcript.js";
import { createGhGraphqlClient, type GraphQLClient } from "./github-graphql.js";
import { gh } from "./github.js";

export interface AttachmentSource {
  kind: string;
  id?: string;
  url?: string;
  author?: string;
  title?: string;
}

export interface AttachmentTextSource {
  source: AttachmentSource;
  body: string;
}

export interface AttachmentReference {
  url: string;
  sources: AttachmentSource[];
}

export interface AttachmentManifestError {
  stage: string;
  message: string;
}

export type AttachmentStatus = "downloaded" | "error";

export interface AttachmentManifestEntry {
  url: string;
  status: AttachmentStatus;
  filename: string;
  localPath: string;
  contentType: string;
  sizeBytes: number | null;
  httpStatus: number | null;
  error: string;
  sources: AttachmentSource[];
}

export interface AttachmentManifest {
  generatedAt: string;
  target: {
    repo: string;
    kind: string;
    number: number;
  };
  outputDir: string;
  attachments: AttachmentManifestEntry[];
  errors: AttachmentManifestError[];
}

export interface AttachmentHeadersLike {
  get(name: string): string | null;
}

export interface AttachmentResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  headers: AttachmentHeadersLike;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type AttachmentFetch = (
  url: string,
  init: {
    headers: Record<string, string>;
    redirect: "follow";
  },
) => Promise<AttachmentResponseLike>;

export type GhJson = <T>(args: string[]) => T;

type FetchDiscussionTranscript = typeof fetchDiscussionTranscript;

interface GitHubActorRecord {
  login?: string | null;
}

interface IssueOrPrRecord {
  title?: string | null;
  body?: string | null;
  html_url?: string | null;
  user?: GitHubActorRecord | null;
}

interface IssueCommentRecord {
  id?: number | string | null;
  body?: string | null;
  html_url?: string | null;
  user?: GitHubActorRecord | null;
}

interface PullReviewRecord extends IssueCommentRecord {
  state?: string | null;
}

interface PullReviewCommentRecord extends IssueCommentRecord {
  path?: string | null;
}

const GITHUB_ATTACHMENT_URL_RE =
  /https:\/\/github\.com\/user-attachments\/(?:files|assets)\/[^\s<>"']+/g;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimAttachmentUrl(value: string): string {
  let out = value.trim();
  while (/[),.;:!?}\]]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return out;
}

export function isGitHubAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      /^\/user-attachments\/(?:files|assets)\//.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function extractAttachmentUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of String(text || "").matchAll(GITHUB_ATTACHMENT_URL_RE)) {
    const url = trimAttachmentUrl(match[0]);
    if (isGitHubAttachmentUrl(url)) {
      found.push(url);
    }
  }
  return found;
}

function sourceKey(source: AttachmentSource): string {
  return [
    source.kind,
    source.id || "",
    source.url || "",
    source.author || "",
    source.title || "",
  ].join("\0");
}

export function collectAttachmentReferences(
  sources: AttachmentTextSource[],
): AttachmentReference[] {
  const byUrl = new Map<
    string,
    { reference: AttachmentReference; sourceKeys: Set<string> }
  >();

  for (const item of sources) {
    for (const url of extractAttachmentUrls(item.body)) {
      let entry = byUrl.get(url);
      if (!entry) {
        entry = {
          reference: { url, sources: [] },
          sourceKeys: new Set<string>(),
        };
        byUrl.set(url, entry);
      }

      const key = sourceKey(item.source);
      if (!entry.sourceKeys.has(key)) {
        entry.reference.sources.push(item.source);
        entry.sourceKeys.add(key);
      }
    }
  }

  return Array.from(byUrl.values(), (entry) => entry.reference);
}

function defaultGhJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

function pagedGhApi<T>(ghJson: GhJson, endpoint: string): T[] {
  const data = ghJson<T[][] | T[]>([
    "api",
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    endpoint,
  ]);
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return (data as T[][]).flat();
  }
  return Array.isArray(data) ? (data as T[]) : [];
}

function sourceBody(title: string | null | undefined, body: string | null | undefined): string {
  return [title || "", body || ""].filter(Boolean).join("\n\n");
}

function actorLogin(record: { user?: GitHubActorRecord | null }): string {
  return record.user?.login || "";
}

function addIssueOrPrSources(args: {
  sources: AttachmentTextSource[];
  number: number;
  kind: "issue" | "pull_request";
  record: IssueOrPrRecord;
}): void {
  args.sources.push({
    source: {
      kind: args.kind,
      id: String(args.number),
      url: args.record.html_url || "",
      author: actorLogin(args.record),
      title: args.record.title || "",
    },
    body: sourceBody(args.record.title, args.record.body),
  });
}

function addIssueCommentSources(
  sources: AttachmentTextSource[],
  comments: IssueCommentRecord[],
): void {
  for (const comment of comments) {
    sources.push({
      source: {
        kind: "issue_comment",
        id: String(comment.id || ""),
        url: comment.html_url || "",
        author: actorLogin(comment),
      },
      body: comment.body || "",
    });
  }
}

function addPullReviewSources(
  sources: AttachmentTextSource[],
  reviews: PullReviewRecord[],
): void {
  for (const review of reviews) {
    sources.push({
      source: {
        kind: "pull_request_review",
        id: String(review.id || ""),
        url: review.html_url || "",
        author: actorLogin(review),
        title: review.state || "",
      },
      body: review.body || "",
    });
  }
}

function addPullReviewCommentSources(
  sources: AttachmentTextSource[],
  comments: PullReviewCommentRecord[],
): void {
  for (const comment of comments) {
    sources.push({
      source: {
        kind: "pull_request_review_comment",
        id: String(comment.id || ""),
        url: comment.html_url || "",
        author: actorLogin(comment),
        title: comment.path || "",
      },
      body: comment.body || "",
    });
  }
}

function addDiscussionReplySource(
  sources: AttachmentTextSource[],
  reply: DiscussionTranscriptReply,
  kind: string,
): void {
  sources.push({
    source: {
      kind,
      id: reply.id,
      author: reply.author,
      title: reply.createdAt,
    },
    body: reply.body,
  });
}

function addDiscussionCommentSources(
  sources: AttachmentTextSource[],
  comments: DiscussionTranscriptComment[],
): void {
  for (const comment of comments) {
    addDiscussionReplySource(sources, comment, "discussion_comment");
    for (const reply of comment.replies) {
      addDiscussionReplySource(sources, reply, "discussion_reply");
    }
  }
}

export function collectAttachmentTextSources(options: {
  repo: string;
  targetKind: string;
  targetNumber: number;
  requestText?: string;
  ghJson?: GhJson;
  graphQLClient?: GraphQLClient;
  fetchDiscussionTranscript?: FetchDiscussionTranscript;
}): { sources: AttachmentTextSource[]; errors: AttachmentManifestError[] } {
  const sources: AttachmentTextSource[] = [];
  const errors: AttachmentManifestError[] = [];
  const ghJson = options.ghJson || defaultGhJson;

  if (options.requestText) {
    sources.push({
      source: { kind: "request_text" },
      body: options.requestText,
    });
  }

  const repo = options.repo.trim();
  const [owner, repoName] = repo.split("/", 2);
  if (!repo || !owner || !repoName) {
    errors.push({
      stage: "collect_target",
      message: "Could not determine repository slug for attachment scanning.",
    });
    return { sources, errors };
  }

  const number = options.targetNumber;
  if (!Number.isInteger(number) || number <= 0) {
    return { sources, errors };
  }

  try {
    if (options.targetKind === "issue") {
      const issue = ghJson<IssueOrPrRecord>([
        "api",
        "--method",
        "GET",
        `repos/${repo}/issues/${number}`,
      ]);
      addIssueOrPrSources({
        sources,
        number,
        kind: "issue",
        record: issue,
      });
      addIssueCommentSources(
        sources,
        pagedGhApi<IssueCommentRecord>(ghJson, `repos/${repo}/issues/${number}/comments`),
      );
    } else if (options.targetKind === "pull_request") {
      const pr = ghJson<IssueOrPrRecord>([
        "api",
        "--method",
        "GET",
        `repos/${repo}/pulls/${number}`,
      ]);
      addIssueOrPrSources({
        sources,
        number,
        kind: "pull_request",
        record: pr,
      });
      addIssueCommentSources(
        sources,
        pagedGhApi<IssueCommentRecord>(ghJson, `repos/${repo}/issues/${number}/comments`),
      );
      addPullReviewSources(
        sources,
        pagedGhApi<PullReviewRecord>(ghJson, `repos/${repo}/pulls/${number}/reviews`),
      );
      addPullReviewCommentSources(
        sources,
        pagedGhApi<PullReviewCommentRecord>(ghJson, `repos/${repo}/pulls/${number}/comments`),
      );
    } else if (options.targetKind === "discussion") {
      const fetchTranscript = options.fetchDiscussionTranscript || fetchDiscussionTranscript;
      const client = options.graphQLClient || createGhGraphqlClient();
      const transcript = fetchTranscript(client, owner, repoName, number);
      sources.push({
        source: {
          kind: "discussion",
          id: transcript.discussionMeta.id,
          url: transcript.discussionMeta.url,
          author: transcript.discussionMeta.author,
          title: transcript.discussionMeta.title,
        },
        body: sourceBody(transcript.discussionMeta.title, transcript.discussionMeta.body),
      });
      addDiscussionCommentSources(sources, transcript.comments);
    }
  } catch (error: unknown) {
    errors.push({
      stage: "collect_target",
      message: errorMessage(error),
    });
  }

  return { sources, errors };
}

function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function filenameFromContentDisposition(value: string): string {
  const header = String(value || "");
  const encodedMatch = header.match(/(?:^|;)\s*filename\*\s*=\s*(?:(?:UTF-8)?'')?([^;]+)/i);
  if (encodedMatch) {
    return decodeMaybe(encodedMatch[1].trim().replace(/^"|"$/g, ""));
  }

  const plainMatch = header.match(/(?:^|;)\s*filename\s*=\s*("[^"]+"|[^;]+)/i);
  if (plainMatch) {
    return plainMatch[1].trim().replace(/^"|"$/g, "");
  }

  return "";
}

function filenameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    return decodeMaybe(basename(url.pathname));
  } catch {
    return "";
  }
}

export function sanitizeAttachmentFilename(value: string, fallback: string): string {
  const leaf = String(value || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop() || "";
  const sanitized = leaf
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return sanitized || fallback;
}

function deterministicFilename(index: number, url: string, preferredName: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
  const fallback = hash;
  const safeName = sanitizeAttachmentFilename(preferredName, fallback);
  return `attachment-${String(index + 1).padStart(3, "0")}-${safeName}`;
}

function responseHeader(response: AttachmentResponseLike, name: string): string {
  return response.headers.get(name) || "";
}

function makeErrorEntry(args: {
  reference: AttachmentReference;
  filename: string;
  httpStatus: number | null;
  contentType?: string;
  error: string;
}): AttachmentManifestEntry {
  return {
    url: args.reference.url,
    status: "error",
    filename: args.filename,
    localPath: "",
    contentType: args.contentType || "",
    sizeBytes: null,
    httpStatus: args.httpStatus,
    error: args.error,
    sources: args.reference.sources,
  };
}

export async function downloadGitHubAttachments(options: {
  references: AttachmentReference[];
  outputDir: string;
  repo: string;
  targetKind: string;
  targetNumber: number;
  token: string;
  fetch?: AttachmentFetch;
  now?: Date;
}): Promise<AttachmentManifest> {
  mkdirSync(options.outputDir, { recursive: true });
  const fetcher = options.fetch || (globalThis.fetch as unknown as AttachmentFetch);
  const entries: AttachmentManifestEntry[] = [];
  const errors: AttachmentManifestError[] = [];

  for (let index = 0; index < options.references.length; index += 1) {
    const reference = options.references[index];
    const fallbackName = filenameFromUrl(reference.url);
    let filename = deterministicFilename(index, reference.url, fallbackName);

    if (!options.token.trim()) {
      entries.push(
        makeErrorEntry({
          reference,
          filename,
          httpStatus: null,
          error: "Missing GitHub token for attachment download.",
        }),
      );
      continue;
    }

    try {
      const response = await fetcher(reference.url, {
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: "application/octet-stream",
          "User-Agent": "sepo-agent-attachments",
        },
        redirect: "follow",
      });
      const contentType = responseHeader(response, "content-type");
      const contentDisposition = responseHeader(response, "content-disposition");
      const headerFilename = filenameFromContentDisposition(contentDisposition);
      if (headerFilename) {
        filename = deterministicFilename(index, reference.url, headerFilename);
      }

      if (!response.ok) {
        entries.push(
          makeErrorEntry({
            reference,
            filename,
            httpStatus: response.status,
            contentType,
            error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
          }),
        );
        continue;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const localPath = join(options.outputDir, filename);
      writeFileSync(localPath, bytes);
      entries.push({
        url: reference.url,
        status: "downloaded",
        filename,
        localPath,
        contentType,
        sizeBytes: bytes.length,
        httpStatus: response.status,
        error: "",
        sources: reference.sources,
      });
    } catch (error: unknown) {
      entries.push(
        makeErrorEntry({
          reference,
          filename,
          httpStatus: null,
          error: errorMessage(error),
        }),
      );
    }
  }

  return {
    generatedAt: (options.now || new Date()).toISOString(),
    target: {
      repo: options.repo,
      kind: options.targetKind,
      number: options.targetNumber,
    },
    outputDir: options.outputDir,
    attachments: entries,
    errors,
  };
}

export function writeAttachmentManifest(path: string, manifest: AttachmentManifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}
