import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SessionPolicy } from "./session-policy.js";
import { attemptsResume } from "./session-policy.js";

export const SESSION_BUNDLE_SCHEMA_VERSION = 1;

export type SessionBundleMode = "auto" | "always" | "never";
export type SessionBundleRestoreStatus =
  | "not_applicable"
  | "not_available"
  | "restored"
  | "failed";

export interface SessionBundleManifestFile {
  relative_path: string;
  size_bytes: number;
  sha256: string;
}

export interface SessionBundleManifest {
  schema_version: number;
  agent: string;
  thread_key: string;
  repo_slug: string;
  cwd: string;
  acpx_record_id: string;
  acpx_session_id: string;
  created_at: string;
  files: SessionBundleManifestFile[];
}

export interface SessionBundleFile extends SessionBundleManifestFile {
  absolute_path: string;
}

export interface CreatedSessionBundle {
  bundlePath: string;
  manifest: SessionBundleManifest;
  totalSizeBytes: number;
  fileCount: number;
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sanitizeArtifactComponent(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "default";
}

function escapeFindNamePattern(value: string): string {
  return value.replace(/([*?\[\]\\])/g, "\\$1");
}

function findFilesByName(root: string, pattern: string): string[] {
  if (!root || !existsSync(root)) {
    return [];
  }

  try {
    const output = execFileSync("find", [root, "-type", "f", "-name", pattern], {
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).toString("utf8");
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function toHomeRelativePath(absolutePath: string, homeDir: string): string | null {
  const resolvedHome = resolve(homeDir);
  const resolvedPath = resolve(absolutePath);
  const rel = relative(resolvedHome, resolvedPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return rel.replace(/\\/g, "/");
}

function addBundleFile(
  files: Map<string, SessionBundleFile>,
  absolutePath: string,
  homeDir: string,
): void {
  if (!existsSync(absolutePath)) {
    return;
  }

  const relativePath = toHomeRelativePath(absolutePath, homeDir);
  if (!relativePath || files.has(relativePath)) {
    return;
  }

  const stats = statSync(absolutePath);
  if (!stats.isFile()) {
    return;
  }

  files.set(relativePath, {
    absolute_path: absolutePath,
    relative_path: relativePath,
    size_bytes: stats.size,
    sha256: sha256File(absolutePath),
  });
}

export function parseSessionBundleMode(value: string | undefined): SessionBundleMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "always" || normalized === "never") {
    return normalized;
  }
  return "auto";
}

export function shouldUseSessionBundles(
  mode: SessionBundleMode,
  policy: SessionPolicy,
): boolean {
  if (policy === "none" || mode === "never") {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  return attemptsResume(policy);
}

export function hasValidThreadTargetNumber(targetKind: string, targetNumber: number): boolean {
  if (!Number.isFinite(targetNumber)) {
    return false;
  }
  if (targetKind === "repository") {
    return targetNumber >= 0;
  }
  return targetNumber > 0;
}

export function buildSessionBundleArtifactName(
  threadKey: string,
  runId: string,
): string {
  const [, targetKind = "target", targetNumber = "0", route = "route", lane = "default"] =
    String(threadKey || "").split(":");
  const suffix = shortHash(threadKey);
  const parts = [
    "session-bundle",
    sanitizeArtifactComponent(targetKind),
    sanitizeArtifactComponent(targetNumber),
    sanitizeArtifactComponent(route),
    sanitizeArtifactComponent(lane),
    suffix,
    sanitizeArtifactComponent(runId || "run"),
  ];
  return parts.join("-");
}

export function formatSessionRestoreNotice(args: {
  resumeStatus?: string;
  runStatus?: string;
}): string {
  const resumeStatus = String(args.resumeStatus || "").trim().toLowerCase();
  const runStatus = String(args.runStatus || "").trim().toLowerCase();

  if (resumeStatus === "fallback_fresh") {
    if (runStatus === "success" || runStatus === "no_changes" || runStatus === "verify_failed") {
      return "Session continuity could not be restored, so this run continued with a fresh session.";
    }
    return "Session continuity could not be restored for this run.";
  }

  if (resumeStatus === "failed") {
    return "Session continuity could not be restored for this run.";
  }

  return "";
}

export function discoverSessionBundleFiles(args: {
  agent: string;
  acpxRecordId: string;
  acpxSessionId: string;
  homeDir: string;
}): SessionBundleFile[] {
  const files = new Map<string, SessionBundleFile>();
  const normalizedAgent = String(args.agent || "").trim().toLowerCase();
  const homeDir = resolve(args.homeDir);

  if (args.acpxRecordId) {
    addBundleFile(
      files,
      join(homeDir, ".acpx", "sessions", `${args.acpxRecordId}.json`),
      homeDir,
    );
    addBundleFile(
      files,
      join(homeDir, ".acpx", "sessions", `${args.acpxRecordId}.stream.ndjson`),
      homeDir,
    );
  }

  if (args.acpxSessionId) {
    if (normalizedAgent === "codex") {
      for (const match of findFilesByName(
        join(homeDir, ".codex", "sessions"),
        `*${escapeFindNamePattern(args.acpxSessionId)}*.jsonl`,
      )) {
        addBundleFile(files, match, homeDir);
      }
    }

    if (normalizedAgent === "claude") {
      for (const match of findFilesByName(
        join(homeDir, ".claude", "projects"),
        `*${escapeFindNamePattern(args.acpxSessionId)}*.jsonl`,
      )) {
        addBundleFile(files, match, homeDir);
      }
    }
  }

  return Array.from(files.values()).sort((a, b) =>
    a.relative_path.localeCompare(b.relative_path),
  );
}

export function createSessionBundle(args: {
  agent: string;
  threadKey: string;
  repoSlug: string;
  cwd: string;
  acpxRecordId: string;
  acpxSessionId: string;
  homeDir: string;
  runnerTemp?: string;
}): CreatedSessionBundle | null {
  const files = discoverSessionBundleFiles({
    agent: args.agent,
    acpxRecordId: args.acpxRecordId,
    acpxSessionId: args.acpxSessionId,
    homeDir: args.homeDir,
  });

  if (files.length === 0) {
    return null;
  }

  const stageDir = mkdtempSync(join(args.runnerTemp || tmpdir(), "session-bundle-stage-"));
  const payloadDir = join(stageDir, "files");
  mkdirSync(payloadDir, { recursive: true });

  const manifest: SessionBundleManifest = {
    schema_version: SESSION_BUNDLE_SCHEMA_VERSION,
    agent: args.agent,
    thread_key: args.threadKey,
    repo_slug: args.repoSlug,
    cwd: args.cwd,
    acpx_record_id: args.acpxRecordId,
    acpx_session_id: args.acpxSessionId,
    created_at: new Date().toISOString(),
    files: files.map((file) => ({
      relative_path: file.relative_path,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
    })),
  };

  for (const file of files) {
    const target = join(payloadDir, file.relative_path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file.absolute_path, target);
  }

  writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const bundlePath = join(
    args.runnerTemp || tmpdir(),
    `session-bundle-${shortHash(args.threadKey + args.acpxSessionId)}.tgz`,
  );

  execFileSync("tar", ["-czf", bundlePath, "-C", stageDir, "manifest.json", "files"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  rmSync(stageDir, { recursive: true, force: true });

  return {
    bundlePath,
    manifest,
    totalSizeBytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
    fileCount: files.length,
  };
}

function validateManifest(value: unknown): SessionBundleManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Session bundle manifest must be an object");
  }

  const manifest = value as SessionBundleManifest;
  if (manifest.schema_version !== SESSION_BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported session bundle schema: ${String((manifest as { schema_version?: unknown }).schema_version ?? "missing")}`,
    );
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error("Session bundle manifest is missing files");
  }
  return manifest;
}

export function restoreSessionBundle(bundlePath: string, homeDir: string): SessionBundleManifest {
  const extractDir = mkdtempSync(join(tmpdir(), "session-bundle-restore-"));
  const resolvedHome = resolve(homeDir);
  const homePrefix = resolvedHome.endsWith(sep) ? resolvedHome : resolvedHome + sep;

  try {
    execFileSync("tar", ["-xzf", bundlePath, "-C", extractDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const manifest = validateManifest(
      JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf8")),
    );

    for (const file of manifest.files) {
      const rel = String(file.relative_path || "").replace(/\\/g, "/");
      if (!rel || isAbsolute(rel) || rel.startsWith("../") || rel.includes("/../")) {
        throw new Error(`Invalid bundle path: ${rel || "missing"}`);
      }

      const source = join(extractDir, "files", rel);
      if (!existsSync(source)) {
        throw new Error(`Bundle file missing: ${rel}`);
      }

      const actualSha = sha256File(source);
      if (actualSha !== file.sha256) {
        throw new Error(`Bundle file checksum mismatch: ${rel}`);
      }

      const dest = resolve(resolvedHome, rel);
      if (!(dest === resolvedHome || dest.startsWith(homePrefix))) {
        throw new Error(`Bundle path escapes HOME: ${rel}`);
      }

      mkdirSync(dirname(dest), { recursive: true });
      cpSync(source, dest);
    }

    return manifest;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export function findSessionBundleArchive(dir: string): string | null {
  const matches = findFilesByName(dir, "*.tgz");
  return matches[0] || null;
}
