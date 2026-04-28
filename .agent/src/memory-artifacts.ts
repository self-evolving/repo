// Memory branch layout helpers.
//
// The agent writes prose into PROJECT.md / MEMORY.md / daily/ through the
// memory-update CLI. The deterministic sync mirror under github/ is dumped
// as raw `gh --json` output — one JSON file per item, flat layout, type
// encoded in the filename. No custom markdown rendering.

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
  "- `github/*.json` mirrors repository issues, pull requests, and discussions for lookup.",
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

/**
 * Creates the memory branch layout and seeds README.md, PROJECT.md, and
 * MEMORY.md if missing. Idempotent.
 */
export function ensureMemoryStructure(rootDir: string, repoSlug: string): EnsureMemoryStructureResult {
  const createdFiles: string[] = [];

  ensureDirectory(join(rootDir, DAILY_DIR));
  ensureDirectory(join(rootDir, GITHUB_DIR));
  ensureFile(join(rootDir, DAILY_DIR, ".gitkeep"), "", createdFiles);
  ensureFile(join(rootDir, GITHUB_DIR, ".gitkeep"), "", createdFiles);

  ensureFile(join(rootDir, "PROJECT.md"), "", createdFiles);
  ensureFile(join(rootDir, "MEMORY.md"), "", createdFiles);
  ensureFile(join(rootDir, "README.md"), MEMORY_README, createdFiles);

  return { createdFiles };
}

// Flat layout: type is encoded in the filename. No subdirectories, no
// collision between issue #209 and PR #209 (GitHub shares the counter)
// or between discussion #42 and issue #42 (separate counters).

export function issueArtifactPath(rootDir: string, number: number): string {
  return join(rootDir, GITHUB_DIR, `issue-${number}.json`);
}

export function pullRequestArtifactPath(rootDir: string, number: number): string {
  return join(rootDir, GITHUB_DIR, `pull-${number}.json`);
}

export function discussionArtifactPath(rootDir: string, number: number): string {
  return join(rootDir, GITHUB_DIR, `discussion-${number}.json`);
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
