// Shared helpers for creating/reusing implementation tracking issues for
// non-issue request surfaces.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDiscussionComment } from "./discussion.js";
import {
  createIssue,
  fetchAuthenticatedActorLogin,
  fetchIssueCommentRecords,
  gh,
} from "./github.js";
import { postResponse, type ResponseTarget } from "./respond.js";

export interface CommentRecord {
  id?: string | number;
  body?: string;
  authorLogin?: string;
  replyToId?: string | number;
}

export interface SourceTargetMetadata {
  kind: "pull_request" | "discussion";
  number: string;
  label: string;
  title: string;
  body: string;
  url: string;
  discussionId?: string;
}

export interface EnsureImplementationTrackingIssueInput {
  repo: string;
  targetKind: string;
  targetNumber: string;
  sourceRunId?: string;
  trackingScope: string;
  nextRound?: number | string;
  issueTitle?: string;
  issueBody?: string;
  sourceKind?: string;
  targetUrl?: string;
  requestedBy?: string;
  requestText?: string;
  plannerReason?: string;
  handoffContext?: string;
  baseBranch?: string;
  basePr?: string;
  discussionId?: string;
  responseKind?: string;
  reviewCommentId?: string;
  replyToId?: string;
  linkBackLabel?: string;
}

export interface EnsureImplementationTrackingIssueResult {
  issueNumber: string;
  issueUrl: string;
  created: boolean;
  reused: boolean;
}

const IMPLEMENTATION_TRACKING_MARKER_PREFIX = "sepo-implementation-tracking";
const SEPO_CONTROL_MARKER_OPENER_RE = /<!--\s*sepo-/gi;

function errorText(err: unknown): string {
  const record = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [record.message, record.stderr, record.stdout]
    .map((part) => {
      if (Buffer.isBuffer(part)) return part.toString("utf8");
      return typeof part === "string" ? part : "";
    })
    .filter(Boolean)
    .join("\n") || String(err);
}

function extractLogin(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" ? login.trim() : "";
}

function authorLoginFromRecord(record: Record<string, unknown>): string {
  return extractLogin(record.author) || extractLogin(record.user);
}

function normalizeActorLogin(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^app\//i, "")
    .replace(/\[bot\]$/i, "");
}

let authenticatedActorLogin: string | null = null;

function getAuthenticatedActorLogin(): string {
  if (authenticatedActorLogin !== null) return authenticatedActorLogin;
  authenticatedActorLogin = fetchAuthenticatedActorLogin();
  return authenticatedActorLogin;
}

function isTrustedActorLogin(authorLogin: string): boolean {
  const actorLogin = getAuthenticatedActorLogin();
  return Boolean(normalizeActorLogin(authorLogin)) &&
    normalizeActorLogin(authorLogin) === normalizeActorLogin(actorLogin);
}

function normalizeToken(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

function parsePositiveTargetNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseIssueNumberFromUrl(url: string): string {
  const match = String(url || "").trim().match(/\/issues\/(\d+)(?:\D*)?$/);
  return match ? match[1] : "";
}

function issueUrlFromNumber(repoSlug: string, issueNumber: string): string {
  return repoSlug && issueNumber ? `https://github.com/${repoSlug}/issues/${issueNumber}` : "";
}

function escapeRegexText(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitRepoSlug(repoSlug: string): { owner: string; name: string } {
  const [owner = "", name = ""] = String(repoSlug || "").split("/");
  return { owner, name };
}

function fallbackTargetUrl(repoSlug: string, kind: "pull_request" | "discussion", number: string): string {
  if (!repoSlug || !number) return "";
  const path = kind === "pull_request" ? "pull" : "discussions";
  return `https://github.com/${repoSlug}/${path}/${number}`;
}

function normalizeInlineText(value: string): string {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function escapeSepoControlMarkers(value: string): string {
  return String(value || "").replace(
    SEPO_CONTROL_MARKER_OPENER_RE,
    (opener) => opener.replace(/<!--/i, "&lt;!--"),
  );
}

function formatTrackingIssueTitle(metadata: SourceTargetMetadata, providedTitle?: string): string {
  const explicit = truncateText(normalizeInlineText(providedTitle || ""), 70);
  if (explicit) return explicit;
  const targetTitle = normalizeInlineText(metadata.title);
  const fallback = `Implement ${metadata.label} request`;
  const raw = targetTitle ? `Implement ${metadata.label}: ${targetTitle}` : fallback;
  return truncateText(raw, 70) || fallback;
}

function appendMarkdownSection(lines: string[], title: string, value: string, maxLength: number): void {
  const text = truncateText(escapeSepoControlMarkers(value), maxLength);
  if (!text) return;
  lines.push("", `## ${title}`, "", text);
}

function encodeStableMarkerKey(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

function buildImplementationTrackingKey(input: EnsureImplementationTrackingIssueInput): string {
  return [
    "implementation-tracking",
    input.repo.trim().toLowerCase(),
    String(input.sourceRunId || "").trim() || "unknown-run",
    normalizeToken(input.trackingScope || "explicit"),
    normalizeToken(input.targetKind),
    String(input.targetNumber || "").trim(),
    String(input.nextRound || ""),
  ].join(":");
}

function formatImplementationTrackingMarker(input: {
  key: string;
  issueNumber?: string;
}): string {
  const parts = [
    IMPLEMENTATION_TRACKING_MARKER_PREFIX,
    `base64:${encodeStableMarkerKey(input.key)}`,
  ];
  if (input.issueNumber) {
    parts.push(`issue:${input.issueNumber}`);
  }
  return `<!-- ${parts.join(" ")} -->`;
}

function parseImplementationTrackingMarker(body: string, key: string): { issueNumber: string } | null {
  const encoded = escapeRegexText(encodeStableMarkerKey(key));
  const markerRe = new RegExp(
    `<!--\\s*${IMPLEMENTATION_TRACKING_MARKER_PREFIX}\\s+base64:${encoded}(?:\\s+issue:(\\d+))?\\s*-->`,
    "i",
  );
  const match = String(body || "").match(markerRe);
  if (!match) return null;
  return { issueNumber: match[1] || "" };
}

function formatImplementationBase(baseBranchInput: string, basePrInput: string): string {
  const basePr = escapeSepoControlMarkers(basePrInput);
  const baseBranch = escapeSepoControlMarkers(baseBranchInput);
  if (basePr) return `PR #${basePr}`;
  if (baseBranch) return `branch \`${baseBranch}\``;
  return "repository default branch";
}

function fallbackSourceTargetMetadata(
  repoSlug: string,
  kind: "pull_request" | "discussion",
  number: string,
): SourceTargetMetadata {
  const label = kind === "pull_request" ? `PR #${number || "unknown"}` : `discussion #${number || "unknown"}`;
  return {
    kind,
    number,
    label,
    title: "",
    body: "",
    url: fallbackTargetUrl(repoSlug, kind, number),
  };
}

function fetchPullRequestSourceTargetMetadata(repoSlug: string, prNumber: string): SourceTargetMetadata {
  const fallback = fallbackSourceTargetMetadata(repoSlug, "pull_request", prNumber);
  try {
    const raw = gh([
      "pr",
      "view",
      prNumber,
      "--repo",
      repoSlug,
      "--json",
      "title,body,url",
    ]).trim();
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...fallback,
      title: String(parsed.title || ""),
      body: String(parsed.body || ""),
      url: String(parsed.url || "") || fallback.url,
    };
  } catch (err: unknown) {
    console.warn(`Could not read pull request #${prNumber} for tracking issue metadata: ${errorText(err)}`);
    return fallback;
  }
}

export function fetchDiscussionSourceTargetMetadata(repoSlug: string, discussionNumber: string): SourceTargetMetadata {
  const fallback = fallbackSourceTargetMetadata(repoSlug, "discussion", discussionNumber);
  const { owner, name } = splitRepoSlug(repoSlug);
  const parsedNumber = parsePositiveTargetNumber(discussionNumber);
  if (!owner || !name || !parsedNumber) return fallback;

  try {
    const query = `
      query ImplementationTrackingDiscussion($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          discussion(number: $number) {
            id
            title
            body
            url
          }
        }
      }
    `;
    const raw = gh([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${name}`,
      "-F",
      `number=${parsedNumber}`,
    ]).trim();
    const parsed = JSON.parse(raw || "{}") as {
      data?: {
        repository?: {
          discussion?: {
            id?: unknown;
            title?: unknown;
            body?: unknown;
            url?: unknown;
          } | null;
        } | null;
      } | null;
    };
    const discussion = parsed.data?.repository?.discussion;
    if (!discussion) return fallback;
    return {
      ...fallback,
      title: String(discussion.title || ""),
      body: String(discussion.body || ""),
      url: String(discussion.url || "") || fallback.url,
      discussionId: String(discussion.id || "") || undefined,
    };
  } catch (err: unknown) {
    console.warn(`Could not read discussion #${discussionNumber} for tracking issue metadata: ${errorText(err)}`);
    return fallback;
  }
}

function fetchSourceTargetMetadata(input: EnsureImplementationTrackingIssueInput): SourceTargetMetadata | null {
  const normalizedKind = normalizeToken(input.targetKind);
  if (normalizedKind === "pull_request") {
    return fetchPullRequestSourceTargetMetadata(input.repo, input.targetNumber);
  }
  if (normalizedKind === "discussion") {
    const metadata = fetchDiscussionSourceTargetMetadata(input.repo, input.targetNumber);
    return input.discussionId ? { ...metadata, discussionId: input.discussionId } : metadata;
  }
  return null;
}

export function fetchDiscussionCommentRecords(repoSlug: string, discussionNumber: string): CommentRecord[] {
  const { owner, name } = splitRepoSlug(repoSlug);
  const parsedNumber = parsePositiveTargetNumber(discussionNumber);
  if (!owner || !name || !parsedNumber) return [];
  const query = `
    query DiscussionComments($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        discussion(number: $number) {
          comments(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              body
              createdAt
              author { login }
              replies(first: 100) {
                nodes {
                  id
                  body
                  createdAt
                  author { login }
                }
              }
            }
          }
        }
      }
    }
  `;

  const records: CommentRecord[] = [];
  let cursor = "";
  let hasNextPage = true;
  while (hasNextPage) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${name}`,
      "-F",
      `number=${parsedNumber}`,
    ];
    if (cursor) {
      args.push("-f", `cursor=${cursor}`);
    }
    const raw = gh(args).trim();
    const parsed = JSON.parse(raw || "{}") as {
      data?: {
        repository?: {
          discussion?: {
            comments?: {
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
              nodes?: Array<{
                id?: string | number;
                body?: string | null;
                author?: { login?: string | null } | null;
                replies?: {
                  nodes?: Array<{
                    id?: string | number;
                    body?: string | null;
                    author?: { login?: string | null } | null;
                  } | null> | null;
                } | null;
              } | null> | null;
            } | null;
          } | null;
        } | null;
      } | null;
    };
    const comments = parsed.data?.repository?.discussion?.comments;
    for (const comment of comments?.nodes || []) {
      if (!comment) continue;
      records.push({
        id: comment.id,
        body: comment.body || "",
        authorLogin: comment.author?.login || "",
      });
      for (const reply of comment.replies?.nodes || []) {
        if (!reply) continue;
        records.push({
          id: reply.id,
          body: reply.body || "",
          authorLogin: reply.author?.login || "",
          replyToId: comment.id,
        });
      }
    }
    hasNextPage = comments?.pageInfo?.hasNextPage ?? false;
    cursor = comments?.pageInfo?.endCursor || "";
  }
  return records;
}

function normalizeCommentRecord(value: unknown): CommentRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === "string" || typeof record.id === "number" ? record.id : undefined,
    body: String(record.body || ""),
    authorLogin: authorLoginFromRecord(record),
    replyToId: String(record.in_reply_to_id || record.inReplyToId || ""),
  };
}

function fetchPullRequestReviewCommentRecords(repoSlug: string, prNumber: string): CommentRecord[] {
  const number = parsePositiveTargetNumber(prNumber);
  if (!number) return [];
  const raw = gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repoSlug}/pulls/${number}/comments`,
  ]).trim();
  const parsed = JSON.parse(raw || "[]") as unknown;
  const pages = Array.isArray(parsed) && parsed.every((page) => Array.isArray(page))
    ? parsed as unknown[][]
    : [parsed];
  const records: CommentRecord[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const item of page) {
      const record = normalizeCommentRecord(item);
      if (record) records.push(record);
    }
  }
  return records;
}

function formatGeneratedImplementationIssueBody(input: {
  request: EnsureImplementationTrackingIssueInput;
  metadata: SourceTargetMetadata;
  trackingKey: string;
}): string {
  const request = input.request;
  const lines = [
    "## Goal",
    "",
    `Implement the follow-up selected by \`/orchestrate\` for ${input.metadata.label}.`,
    "",
    "## Source target",
    "",
    `- Target kind: \`${input.metadata.kind}\``,
    `- Target number: \`${input.metadata.number || "unknown"}\``,
    `- Target URL: ${input.metadata.url || "unknown"}`,
    `- Requested by: \`${request.requestedBy || "unknown"}\``,
    `- Implementation base: ${formatImplementationBase(request.baseBranch || "", request.basePr || "")}`,
    `- Planner reason: ${escapeSepoControlMarkers(request.plannerReason || "")}`,
  ];

  appendMarkdownSection(lines, "Request", request.requestText || "", 4000);
  appendMarkdownSection(lines, "Orchestrator context", request.handoffContext || request.plannerReason || "", 4000);
  appendMarkdownSection(lines, "Target title", input.metadata.title, 500);
  appendMarkdownSection(lines, "Target body", input.metadata.body, 4000);
  lines.push("", formatImplementationTrackingMarker({ key: input.trackingKey }));

  return `${lines.join("\n").trim()}\n`;
}

function formatExplicitImplementationIssueBody(input: EnsureImplementationTrackingIssueInput, trackingKey: string): string {
  const lines = [escapeSepoControlMarkers(input.issueBody || "").trim()];
  if (input.targetUrl) {
    lines.push("", "---", "", `Requested via ${input.sourceKind || "mention"} at ${input.targetUrl}`);
  }
  lines.push("", formatImplementationTrackingMarker({ key: trackingKey }));
  return `${lines.join("\n").trim()}\n`;
}

function findTrustedImplementationLinkBack(
  repoSlug: string,
  metadata: SourceTargetMetadata,
  trackingKey: string,
  responseTarget?: ResponseTarget,
): string {
  const threadedIssueNumber = findTrustedThreadedImplementationLinkBack(
    repoSlug,
    metadata,
    trackingKey,
    responseTarget,
  );
  if (threadedIssueNumber) return threadedIssueNumber;

  let comments: CommentRecord[] = [];
  if (metadata.kind === "pull_request") {
    const number = parsePositiveTargetNumber(metadata.number);
    if (!number) return "";
    comments = fetchIssueCommentRecords(number, repoSlug);
  } else {
    comments = fetchDiscussionCommentRecords(repoSlug, metadata.number);
  }

  for (const comment of [...comments].reverse()) {
    if (!isTrustedActorLogin(comment.authorLogin || "")) continue;
    const parsed = parseImplementationTrackingMarker(comment.body || "", trackingKey);
    const issueNumber = parsed?.issueNumber || "";
    if (issueNumber) return issueNumber;
  }
  return "";
}

function findTrustedThreadedImplementationLinkBack(
  repoSlug: string,
  metadata: SourceTargetMetadata,
  trackingKey: string,
  responseTarget?: ResponseTarget,
): string {
  if (!responseTarget) return "";
  let comments: CommentRecord[] = [];
  let parentId = "";
  if (
    metadata.kind === "pull_request" &&
    responseTarget.responseKind === "review_comment_reply" &&
    responseTarget.reviewCommentId
  ) {
    comments = fetchPullRequestReviewCommentRecords(repoSlug, metadata.number);
    parentId = String(responseTarget.reviewCommentId);
  } else if (
    metadata.kind === "discussion" &&
    responseTarget.responseKind === "discussion_comment" &&
    responseTarget.replyToId
  ) {
    comments = fetchDiscussionCommentRecords(repoSlug, metadata.number);
    parentId = String(responseTarget.replyToId);
  }
  if (!parentId) return "";

  for (const comment of [...comments].reverse()) {
    if (String(comment.replyToId || "") !== parentId) continue;
    if (!isTrustedActorLogin(comment.authorLogin || "")) continue;
    const parsed = parseImplementationTrackingMarker(comment.body || "", trackingKey);
    const issueNumber = parsed?.issueNumber || "";
    if (issueNumber) return issueNumber;
  }
  return "";
}

function findTrustedImplementationIssueByBody(repoSlug: string, trackingKey: string): string {
  const raw = gh([
    "issue",
    "list",
    "--repo",
    repoSlug,
    "--state",
    "all",
    "--search",
    `${IMPLEMENTATION_TRACKING_MARKER_PREFIX} in:body`,
    "--json",
    "number,title,body,author",
    "--limit",
    "100",
  ]).trim();
  const parsed = JSON.parse(raw || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("could not parse implementation tracking issue search results");
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = parsePositiveTargetNumber(String(record.number || ""));
    const body = String(record.body || "");
    if (
      number &&
      parseImplementationTrackingMarker(body, trackingKey) &&
      isTrustedActorLogin(authorLoginFromRecord(record))
    ) {
      return String(number);
    }
  }
  return "";
}

function findExistingImplementationTrackingIssue(
  repoSlug: string,
  metadata: SourceTargetMetadata,
  trackingKey: string,
  responseTarget?: ResponseTarget,
): string {
  try {
    const linkBackIssueNumber = findTrustedImplementationLinkBack(repoSlug, metadata, trackingKey, responseTarget);
    if (linkBackIssueNumber) return linkBackIssueNumber;
  } catch (err: unknown) {
    console.warn(`Could not inspect existing implementation link-backs: ${errorText(err)}`);
  }
  try {
    return findTrustedImplementationIssueByBody(repoSlug, trackingKey);
  } catch (err: unknown) {
    console.warn(`Could not inspect existing implementation tracking issues: ${errorText(err)}`);
    return "";
  }
}

function postImplementationLinkBack(
  repoSlug: string,
  metadata: SourceTargetMetadata,
  issueUrl: string,
  trackingKey: string,
  linkBackLabel: string,
  responseTarget?: ResponseTarget,
): void {
  const issueNumber = parseIssueNumberFromUrl(issueUrl);
  const marker = formatImplementationTrackingMarker({ key: trackingKey, issueNumber });
  const body = `Implementing ${linkBackLabel} - tracking in ${issueUrl}.\n\n${marker}`;
  try {
    if (findTrustedImplementationLinkBack(repoSlug, metadata, trackingKey, responseTarget)) {
      return;
    }
  } catch (err: unknown) {
    console.warn(`Could not inspect existing implementation link-back for ${metadata.label}: ${errorText(err)}`);
  }
  try {
    if (responseTarget) {
      postResponse(responseTarget, body);
      return;
    }
    if (metadata.kind === "pull_request") {
      const number = parsePositiveTargetNumber(metadata.number);
      if (!number) throw new Error(`invalid pull request number: ${metadata.number}`);
      gh([
        "api",
        "--method",
        "POST",
        `repos/${repoSlug}/issues/${number}/comments`,
        "-f",
        `body=${body}`,
        "--jq",
        ".id",
      ]);
      return;
    }
    if (!metadata.discussionId) {
      console.warn(`Could not post discussion link-back for ${metadata.label}: missing discussion node ID`);
      return;
    }
    addDiscussionComment(metadata.discussionId, body);
  } catch (err: unknown) {
    console.warn(`Could not post implementation link-back to ${metadata.label}: ${errorText(err)}`);
  }
}

function buildLinkBackResponseTarget(
  input: EnsureImplementationTrackingIssueInput,
  metadata: SourceTargetMetadata,
): ResponseTarget | undefined {
  const responseKind = normalizeInlineText(input.responseKind || "");
  if (!responseKind) return undefined;
  const targetNumber = parsePositiveTargetNumber(input.targetNumber);
  if (!targetNumber) return undefined;
  return {
    responseKind,
    targetNumber,
    reviewCommentId: parsePositiveTargetNumber(input.reviewCommentId || "") || undefined,
    discussionNodeId: input.discussionId || metadata.discussionId,
    replyToId: normalizeInlineText(input.replyToId || "") || undefined,
    repo: input.repo,
  };
}

function withTempBodyFile<T>(body: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sepo-implementation-tracking-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, body, "utf8");
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function ensureImplementationTrackingIssueForTarget(
  input: EnsureImplementationTrackingIssueInput,
): EnsureImplementationTrackingIssueResult {
  if (normalizeToken(input.targetKind) === "issue") {
    const issueNumber = input.targetNumber;
    return {
      issueNumber,
      issueUrl: issueUrlFromNumber(input.repo, issueNumber),
      created: false,
      reused: true,
    };
  }

  const metadata = fetchSourceTargetMetadata(input);
  if (!metadata) {
    throw new Error(`implementation tracking cannot create tracking issue for ${input.targetKind || "missing"} targets`);
  }
  const trackingKey = buildImplementationTrackingKey(input);
  const linkBackLabel = input.linkBackLabel || "this request";
  const linkBackResponseTarget = buildLinkBackResponseTarget(input, metadata);
  const existingIssueNumber = findExistingImplementationTrackingIssue(
    input.repo,
    metadata,
    trackingKey,
    linkBackResponseTarget,
  );
  if (existingIssueNumber) {
    const issueUrl = issueUrlFromNumber(input.repo, existingIssueNumber);
    postImplementationLinkBack(input.repo, metadata, issueUrl, trackingKey, linkBackLabel, linkBackResponseTarget);
    return {
      issueNumber: existingIssueNumber,
      issueUrl,
      created: false,
      reused: true,
    };
  }

  const title = formatTrackingIssueTitle(metadata, input.issueTitle || "");
  const body = input.issueBody
    ? formatExplicitImplementationIssueBody(input, trackingKey)
    : formatGeneratedImplementationIssueBody({ request: input, metadata, trackingKey });
  const issueUrl = withTempBodyFile(body, (bodyFile) => createIssue({
    repo: input.repo,
    title,
    bodyFile,
  }));
  const issueNumber = parseIssueNumberFromUrl(issueUrl);
  if (!issueNumber) throw new Error(`Could not parse implementation tracking issue URL: ${issueUrl}`);
  postImplementationLinkBack(input.repo, metadata, issueUrl, trackingKey, linkBackLabel, linkBackResponseTarget);
  return {
    issueNumber,
    issueUrl,
    created: true,
    reused: false,
  };
}
