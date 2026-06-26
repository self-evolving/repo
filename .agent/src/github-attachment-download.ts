import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const DEFAULT_GITHUB_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_GITHUB_ATTACHMENT_TIMEOUT_MS = 30_000;

export interface GitHubAttachmentDownloadResult {
  url: string;
  filename: string;
  localPath: string;
  contentType: string;
  sizeBytes: number;
  httpStatus: number;
}

export type GitHubAttachmentFetch = typeof fetch;

export class GitHubAttachmentDownloadError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "GitHubAttachmentDownloadError";
    this.exitCode = exitCode;
  }
}

function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function trimAttachmentUrl(value: string): string {
  let out = String(value || "").trim();
  out = out.replace(/^<+|>+$/g, "");
  while (/[),.;:!?}\]]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return out;
}

export function normalizeGitHubAttachmentUrl(value: string): string {
  const raw = trimAttachmentUrl(value);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GitHubAttachmentDownloadError("Invalid URL.", 2);
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new GitHubAttachmentDownloadError(
      "Only https://github.com/user-attachments/... URLs are supported.",
      2,
    );
  }

  if (!/^\/user-attachments\/(?:files|assets)\/.+/.test(parsed.pathname)) {
    throw new GitHubAttachmentDownloadError(
      "Only GitHub user attachment file or asset URLs are supported.",
      2,
    );
  }

  return parsed.toString();
}

export function isGitHubAttachmentUrl(value: string): boolean {
  try {
    normalizeGitHubAttachmentUrl(value);
    return true;
  } catch {
    return false;
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

export function sanitizeGitHubAttachmentFilename(value: string, fallback: string): string {
  const leaf =
    String(value || "")
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

export function deterministicGitHubAttachmentFilename(url: string, preferredName: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
  const safeName = sanitizeGitHubAttachmentFilename(preferredName, hash);
  return `github-attachment-${hash}-${safeName}`;
}

function headerValue(response: Response, name: string): string {
  return response.headers.get(name) || "";
}

function parseContentLength(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function readResponseBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = parseContentLength(headerValue(response, "content-length"));
  if (contentLength !== null && contentLength > maxBytes) {
    throw new GitHubAttachmentDownloadError(
      `Attachment is too large: content-length ${contentLength} exceeds limit ${maxBytes}.`,
      1,
    );
  }

  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new GitHubAttachmentDownloadError(
        `Attachment is too large: ${bytes.length} bytes exceeds limit ${maxBytes}.`,
        1,
      );
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        throw new GitHubAttachmentDownloadError(
          `Attachment is too large: exceeded limit ${maxBytes}.`,
          1,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function resolveGitHubAttachmentOutputDir(
  env: { RUNNER_TEMP?: string } = process.env,
): string {
  return join(env.RUNNER_TEMP || tmpdir(), "agent-attachments");
}

export function resolveGitHubAttachmentToken(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.INPUT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || "");
}

export async function downloadGitHubAttachment(options: {
  url: string;
  outputDir: string;
  token: string;
  fetch?: GitHubAttachmentFetch;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<GitHubAttachmentDownloadResult> {
  const url = normalizeGitHubAttachmentUrl(options.url);
  const token = options.token.trim();
  if (!token) {
    throw new GitHubAttachmentDownloadError("Missing GitHub token for attachment download.", 2);
  }

  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_GITHUB_ATTACHMENT_MAX_BYTES);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_GITHUB_ATTACHMENT_TIMEOUT_MS);
  const fetcher = options.fetch || fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let contentType = "";
  let filename = "";
  let httpStatus = 0;
  let bytes: Buffer;
  try {
    const response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/octet-stream",
        "User-Agent": "sepo-agent-github-attachment",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    contentType = headerValue(response, "content-type");
    const contentDisposition = headerValue(response, "content-disposition");
    const preferredName = filenameFromContentDisposition(contentDisposition) || filenameFromUrl(url);
    filename = deterministicGitHubAttachmentFilename(url, preferredName);
    httpStatus = response.status;

    if (!response.ok) {
      throw new GitHubAttachmentDownloadError(
        `Attachment download failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
        1,
      );
    }

    bytes = await readResponseBodyWithLimit(response, maxBytes);
  } catch (error: unknown) {
    if (timedOut || isAbortError(error)) {
      throw new GitHubAttachmentDownloadError(
        `Timed out after ${timeoutMs}ms downloading attachment.`,
        1,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  mkdirSync(options.outputDir, { recursive: true });
  const localPath = join(options.outputDir, filename);
  writeFileSync(localPath, bytes);

  return {
    url,
    filename,
    localPath,
    contentType,
    sizeBytes: bytes.length,
    httpStatus,
  };
}
