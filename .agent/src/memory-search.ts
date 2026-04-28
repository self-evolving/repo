// Filesystem text search over a memory directory tree.
//
// Intentionally simple: no pre-built index, no stemming. The memory tree is
// small enough (MB range) that walking it per query is fine, and we avoid a
// stale-index class of bugs. The agent invokes this on demand through the
// cli/memory/search.js CLI.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";

export interface MemorySearchLineMatch {
  lineNumber: number;
  text: string;
  score: number;
  matchCount: number;
}

export interface MemorySearchResult {
  path: string;
  absolutePath: string;
  score: number;
  matchCount: number;
  matchedTerms: string[];
  snippets: MemorySearchLineMatch[];
}

export interface MemorySearchOptions {
  rootDir: string;
  limit?: number;
  snippetsPerFile?: number;
  maxFileSizeBytes?: number;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_SNIPPETS_PER_FILE = 3;
const DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024;
const PATH_MATCH_WEIGHT = 6;
const PHRASE_MATCH_WEIGHT = 3;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".log",
]);

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let fromIndex = 0;
  while (fromIndex < haystack.length) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index === -1) break;
    count += 1;
    fromIndex = index + Math.max(needle.length, 1);
  }
  return count;
}

function normalizeSearchPhrase(query: string): string {
  return String(query || "").trim().toLowerCase();
}

export function tokenizeMemorySearchQuery(query: string): string[] {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return [];

  const seen = new Set<string>();
  const tokens = normalized
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 || /^[0-9]+$/.test(token))
    .filter((token) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });

  if (tokens.length > 0) return tokens;
  return normalized.length >= 2 ? [normalized] : [];
}

function collectSearchableFiles(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) files.push(fullPath);
    }
  }

  return files.sort();
}

function readTextFile(filePath: string, maxFileSizeBytes: number): string | null {
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size > maxFileSizeBytes) return null;

  const extension = extname(filePath).toLowerCase();
  const buffer = readFileSync(filePath);
  if (!TEXT_FILE_EXTENSIONS.has(extension) && buffer.includes(0)) return null;

  return buffer.toString("utf8");
}

function summarizeLine(text: string, maxLength = 220): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return collapsed.slice(0, maxLength).trimEnd() + "…";
}

function scoreLine(line: string, tokens: string[]): { score: number; count: number; terms: string[] } {
  const lower = line.toLowerCase();
  let score = 0;
  let count = 0;
  const terms: string[] = [];
  for (const token of tokens) {
    const occurrences = countOccurrences(lower, token);
    if (occurrences > 0) {
      score += occurrences * Math.max(token.length, 2);
      count += occurrences;
      terms.push(token);
    }
  }
  return { score, count, terms };
}

function scorePath(pathValue: string, tokens: string[]): { score: number; count: number; terms: string[] } {
  const lower = pathValue.toLowerCase();
  let score = 0;
  let count = 0;
  const terms: string[] = [];
  for (const token of tokens) {
    const occurrences = countOccurrences(lower, token);
    if (occurrences > 0) {
      score += occurrences * Math.max(token.length, 2) * PATH_MATCH_WEIGHT;
      count += occurrences;
      terms.push(token);
    }
  }
  return { score, count, terms };
}

export function searchMemory(
  query: string,
  options: MemorySearchOptions,
): MemorySearchResult[] {
  const tokens = tokenizeMemorySearchQuery(query);
  if (tokens.length === 0) return [];

  const root = resolve(options.rootDir);
  if (!existsSync(root)) {
    throw new Error(`Memory directory not found: ${root}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`Memory path is not a directory: ${root}`);
  }

  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const snippetsPerFile = Math.max(1, options.snippetsPerFile ?? DEFAULT_SNIPPETS_PER_FILE);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const phrase = normalizeSearchPhrase(query);

  const files = collectSearchableFiles(root);
  const results: MemorySearchResult[] = [];

  for (const filePath of files) {
    let content: string | null;
    try {
      content = readTextFile(filePath, maxFileSizeBytes);
    } catch {
      continue;
    }
    if (!content) continue;

    const lines = content.split(/\r?\n/);
    const lineMatches: MemorySearchLineMatch[] = [];
    const relativePath = toPosixPath(relative(root, filePath)) || basename(filePath);
    const pathScored = scorePath(relativePath, tokens);
    let fileScore = pathScored.score;
    let fileMatches = pathScored.count;
    const termsSeen = new Set<string>();
    for (const term of pathScored.terms) termsSeen.add(term);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      const scored = scoreLine(line, tokens);
      const phraseCount = phrase.length >= 2 ? countOccurrences(line.toLowerCase(), phrase) : 0;
      if (phraseCount > 0) {
        scored.score += phraseCount * Math.max(phrase.length, 4) * PHRASE_MATCH_WEIGHT;
        scored.count += phraseCount;
      }
      if (scored.count === 0) continue;
      fileScore += scored.score;
      fileMatches += scored.count;
      for (const term of scored.terms) termsSeen.add(term);
      lineMatches.push({
        lineNumber: index + 1,
        text: summarizeLine(line),
        score: scored.score,
        matchCount: scored.count,
      });
    }

    if (lineMatches.length === 0) {
      if (pathScored.score === 0) continue;
      lineMatches.push({
        lineNumber: 0,
        text: "(matched by filename)",
        score: pathScored.score,
        matchCount: pathScored.count,
      });
    }

    // Prefer lines matching more distinct terms first, then higher score.
    lineMatches.sort((a, b) => b.score - a.score || a.lineNumber - b.lineNumber);

    results.push({
      path: relativePath,
      absolutePath: filePath,
      score: fileScore,
      matchCount: fileMatches,
      matchedTerms: Array.from(termsSeen),
      snippets: lineMatches.slice(0, snippetsPerFile),
    });
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return results.slice(0, limit);
}

export function formatMemorySearchResults(
  query: string,
  results: MemorySearchResult[],
  rootDir: string,
): string {
  const header = `Memory search: "${query}"  (${results.length} file${results.length === 1 ? "" : "s"} in ${resolve(rootDir)})\n`;
  if (results.length === 0) {
    return `${header}\n_No matches found._\n`;
  }

  const body = results
    .map((result) => {
      const lines = [
        `\n## ${result.path}  (score=${result.score}, matches=${result.matchCount})`,
        `Matched terms: ${result.matchedTerms.join(", ") || "(none)"}`,
      ];
      for (const snippet of result.snippets) {
        lines.push(
          snippet.lineNumber > 0
            ? `  L${snippet.lineNumber}: ${snippet.text}`
            : `  Path match: ${snippet.text}`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");

  return `${header}${body}\n`;
}
