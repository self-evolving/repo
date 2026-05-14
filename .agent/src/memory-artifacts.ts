// Memory branch layout helpers.
//
// The agent writes prose into PROJECT.md / MEMORY.md / daily/ through the
// memory-update CLI. The deterministic sync mirror under github/<owner>/<repo>/
// is dumped as raw `gh --json` output — one JSON file per item, type encoded
// in the filename. No custom markdown rendering.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const GITHUB_DIR = "github";
export const DAILY_DIR = "daily";

export const MEMORY_README = [
  "# Agent memory",
  "",
  "This branch stores durable context for Sepo agents. It is separate from `main` so memory updates do not mix with product code.",
  "",
  "## Layout",
  "",
  "- `PROJECT.md` holds slow-changing project context: goals, constraints, and open questions.",
  "- `MEMORY.md` holds durable conventions and lessons the agent should carry forward.",
  "- `daily/YYYY-MM-DD.md` holds append-only daily activity bullets.",
  "- `github/<owner>/<repo>/*.json` mirrors repository issues, pull requests, and discussions for lookup.",
  "- Mirrored artifacts can be cited in notes as backlink-style paths, for example `[[github/<owner>/<repo>/issue-1.json]]`.",
  "",
  "These files are the starting structure. Agents may add other notes when that keeps durable context easier to use.",
  "",
  "## Tools",
  "",
  "Memory-related CLI tools live on the `main` branch under `.agent/dist/cli/memory/` after the agent package is built. Useful tools include:",
  "",
  "- `search.js` for searching markdown and JSON memory files.",
  "- `update.js` for adding, replacing, removing, or appending standard memory bullets.",
  "",
].join("\n");

export interface EnsureMemoryStructureResult {
  createdFiles: string[];
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function ensureFile(path: string, content: string, createdFiles: string[]): void {
  if (existsSync(path)) return;
  ensureDirectory(dirname(path));
  writeFileSync(path, content, "utf8");
  createdFiles.push(path);
}

function splitRepoSlug(repoSlug: string): [string, string] {
  const parts = repoSlug.split("/");
  if (
    parts.length !== 2
    || !parts[0]
    || !parts[1]
    || parts.some((part) => part === "." || part === ".." || part.includes("\\"))
  ) {
    throw new Error(`Invalid repository slug: ${repoSlug || "empty"}`);
  }
  return [parts[0], parts[1]];
}

/**
 * Creates the memory branch layout and seeds README.md, PROJECT.md, and
 * MEMORY.md if missing. Idempotent.
 */
export function ensureMemoryStructure(rootDir: string, repoSlug: string): EnsureMemoryStructureResult {
  const createdFiles: string[] = [];
  splitRepoSlug(repoSlug);

  ensureDirectory(join(rootDir, DAILY_DIR));
  ensureDirectory(join(rootDir, GITHUB_DIR));
  ensureDirectory(githubArtifactDir(rootDir, repoSlug));
  ensureFile(join(rootDir, DAILY_DIR, ".gitkeep"), "", createdFiles);
  ensureFile(join(rootDir, GITHUB_DIR, ".gitkeep"), "", createdFiles);
  ensureFile(join(githubArtifactDir(rootDir, repoSlug), ".gitkeep"), "", createdFiles);

  ensureFile(join(rootDir, "PROJECT.md"), "", createdFiles);
  ensureFile(join(rootDir, "MEMORY.md"), "", createdFiles);
  ensureFile(join(rootDir, "README.md"), MEMORY_README, createdFiles);

  return { createdFiles };
}

// Repo-aware layout: each repository gets its own namespace under github/.
// Type is encoded in the filename, so issue #209, PR #209, and discussion #209
// never collide inside the same repo namespace.

export function githubArtifactDir(rootDir: string, repoSlug: string): string {
  const [owner, repo] = splitRepoSlug(repoSlug);
  return join(rootDir, GITHUB_DIR, owner, repo);
}

export function issueArtifactPath(rootDir: string, repoSlug: string, number: number): string {
  return join(githubArtifactDir(rootDir, repoSlug), `issue-${number}.json`);
}

export function pullRequestArtifactPath(rootDir: string, repoSlug: string, number: number): string {
  return join(githubArtifactDir(rootDir, repoSlug), `pull-${number}.json`);
}

export function discussionArtifactPath(rootDir: string, repoSlug: string, number: number): string {
  return join(githubArtifactDir(rootDir, repoSlug), `discussion-${number}.json`);
}

/**
 * Writes `content` to `path` iff it would change the file. Returns whether
 * an on-disk write happened.
 */
export function writeFileIfChanged(path: string, content: string): boolean {
  ensureDirectory(dirname(path));
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  writeFileSync(path, content, "utf8");
  return true;
}
