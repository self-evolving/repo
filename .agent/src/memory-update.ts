// Safe, validated bullet-level edits to MEMORY.md / PROJECT.md / daily logs.
//
// The main agent composes memory during normal execution routes; this module
// is the sanctioned helper for validated bullet-level edits when the agent
// wants section placement, formatting, and dedup handled automatically.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const MEMORY_FILE = "MEMORY.md";
export const PROJECT_FILE = "PROJECT.md";
export const DAILY_DIR = "daily";
export const DAILY_ACTIVITY_SECTION = "Activity";

export type EditableFile = typeof MEMORY_FILE | typeof PROJECT_FILE;

// Outcomes of a mutation attempt. `deduped` means: `replace` resolved a match,
// but the `--with` replacement already exists as a distinct bullet in the
// section, so the matched source bullet is removed and the existing target is
// left in place (net effect: one fewer bullet, no duplicate created).
export type UpdateAction =
  | { kind: "added" }
  | { kind: "deduped" }
  | { kind: "noop"; reason: "duplicate" }
  | { kind: "replaced" }
  | { kind: "removed" }
  | { kind: "missing_section"; section: string }
  | { kind: "missing_match"; match: string }
  | { kind: "ambiguous_match"; match: string; candidates: string[] };

export interface UpdateResult {
  action: UpdateAction;
  file: string;
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 50;
const STALE_LOCK_MS = 30_000;
const PREVIEW_CHARS = 120;

const LOCK_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function normalizeBullet(raw: string): string {
  const collapsed = String(raw || "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "";
  const stripped = collapsed.replace(/^[-*+]\s+/, "");
  if (!stripped) return "";
  return `- ${stripped}`;
}

function sectionHeader(name: string): string {
  return `## ${name}`;
}

function titleForEditableFile(file: EditableFile): string {
  return file === MEMORY_FILE ? "Memory" : "Project";
}

function seedEmptyEditableFile(file: EditableFile, section: string): string[] {
  return [`# ${titleForEditableFile(file)}`, "", sectionHeader(section)];
}

interface SectionSpan {
  headerIndex: number;
  bodyStart: number;
  bodyEnd: number;
}

function findSection(lines: string[], name: string): SectionSpan | null {
  const header = sectionHeader(name).trim();
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) return null;

  let bodyEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i]!)) {
      bodyEnd = i;
      break;
    }
  }
  return { headerIndex, bodyStart: headerIndex + 1, bodyEnd };
}

function bulletsInSpan(lines: string[], span: SectionSpan): string[] {
  return lines
    .slice(span.bodyStart, span.bodyEnd)
    .filter((line) => /^[-*+]\s+/.test(line.trim()))
    .map((line) => normalizeBullet(line));
}

interface BulletMatch {
  index: number;
  normalized: string;
}

function bulletPreview(text: string): string {
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…`
    : text;
}

function findBulletMatches(lines: string[], span: SectionSpan, needle: string): BulletMatch[] {
  const out: BulletMatch[] = [];
  for (let i = span.bodyStart; i < span.bodyEnd; i += 1) {
    const line = lines[i]!;
    if (!/^[-*+]\s+/.test(line.trim())) continue;
    if (line.toLowerCase().includes(needle)) {
      out.push({ index: i, normalized: normalizeBullet(line) });
    }
  }
  return out;
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8").replace(/\r/g, "");
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function writeLines(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tempPath, lines.join("\n") + "\n", "utf8");
  renameSync(tempPath, path);
}

function sleepMs(ms: number): void {
  Atomics.wait(LOCK_SLEEP_ARRAY, 0, 0, ms);
}

function withFileLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, "wx");
      try {
        return fn();
      } finally {
        closeSync(fd);
        fd = null;
        rmSync(lockPath, { force: true });
      }
    } catch (error: unknown) {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw error;

      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > STALE_LOCK_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // statSync failed — most commonly because the lock holder released
        // the lockfile between our openSync and statSync. Retry the loop;
        // we'll likely acquire the lock on the next iteration.
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for memory lock: ${lockPath}`);
      }
      sleepMs(LOCK_POLL_MS);
    }
  }
}

function assertBullet(bullet: string): string {
  const normalized = normalizeBullet(bullet);
  if (!normalized) throw new Error("Bullet text must be non-empty");
  return normalized;
}

export interface EditOptions {
  root: string;
  file: EditableFile;
  section: string;
}

export function addBullet(
  options: EditOptions,
  bullet: string,
): UpdateResult {
  const path = join(options.root, options.file);
  const normalized = assertBullet(bullet);
  return withFileLock(path, () => {
    const lines = readLines(path);
    const seededLines = lines.length === 0
      ? seedEmptyEditableFile(options.file, options.section)
      : lines;

    const span = findSection(seededLines, options.section);
    if (!span) {
      return { action: { kind: "missing_section", section: options.section }, file: path };
    }

    const existing = new Set(bulletsInSpan(seededLines, span));
    if (existing.has(normalized)) {
      return { action: { kind: "noop", reason: "duplicate" }, file: path };
    }

    const insertAt = span.bodyEnd;
    const nextLines = [
      ...seededLines.slice(0, insertAt),
      normalized,
      ...seededLines.slice(insertAt),
    ];
    writeLines(path, nextLines);
    return { action: { kind: "added" }, file: path };
  });
}

export function replaceBullet(
  options: EditOptions,
  match: string,
  replacement: string,
): UpdateResult {
  const path = join(options.root, options.file);
  const normalizedReplacement = assertBullet(replacement);
  const needle = String(match || "").trim().toLowerCase();
  if (!needle) throw new Error("--match is required for replace");
  return withFileLock(path, () => {
    const lines = readLines(path);
    const span = findSection(lines, options.section);
    if (!span) {
      return { action: { kind: "missing_section", section: options.section }, file: path };
    }

    const matches = findBulletMatches(lines, span, needle);
    if (matches.length === 0) {
      return { action: { kind: "missing_match", match }, file: path };
    }

    const uniqueMatches = new Set(matches.map((entry) => entry.normalized));
    if (uniqueMatches.size > 1) {
      return {
        action: {
          kind: "ambiguous_match",
          match,
          candidates: Array.from(uniqueMatches, (entry) => bulletPreview(entry)),
        },
        file: path,
      };
    }

    const matchIndex = matches[0]!.index;
    const currentNormalized = matches[0]!.normalized;
    if (currentNormalized === normalizedReplacement) {
      return { action: { kind: "noop", reason: "duplicate" }, file: path };
    }

    const replacementExists = matchesInSpan(lines, span, normalizedReplacement)
      .some((index) => index !== matchIndex);
    if (replacementExists) {
      lines.splice(matchIndex, 1);
      writeLines(path, lines);
      return { action: { kind: "deduped" }, file: path };
    }

    lines[matchIndex] = normalizedReplacement;
    writeLines(path, lines);
    return { action: { kind: "replaced" }, file: path };
  });
}

export function removeBullet(
  options: EditOptions,
  match: string,
): UpdateResult {
  const path = join(options.root, options.file);
  const needle = String(match || "").trim().toLowerCase();
  if (!needle) throw new Error("--match is required for remove");
  return withFileLock(path, () => {
    const lines = readLines(path);
    const span = findSection(lines, options.section);
    if (!span) {
      return { action: { kind: "missing_section", section: options.section }, file: path };
    }

    const matches = findBulletMatches(lines, span, needle);
    if (matches.length === 0) {
      return { action: { kind: "missing_match", match }, file: path };
    }

    const uniqueMatches = new Set(matches.map((entry) => entry.normalized));
    if (uniqueMatches.size > 1) {
      return {
        action: {
          kind: "ambiguous_match",
          match,
          candidates: Array.from(uniqueMatches, (entry) => bulletPreview(entry)),
        },
        file: path,
      };
    }

    lines.splice(matches[0]!.index, 1);
    writeLines(path, lines);
    return { action: { kind: "removed" }, file: path };
  });
}

export function todayDateUtc(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dailyLogPath(root: string, date: string): string {
  return join(root, DAILY_DIR, `${date}.md`);
}

function ensureDailyLog(path: string, date: string): string[] {
  if (existsSync(path)) return readLines(path);
  const lines = [
    `# Daily log for ${date}`,
    "",
    sectionHeader(DAILY_ACTIVITY_SECTION),
  ];
  writeLines(path, lines);
  return lines;
}

export function appendDailyBullet(
  root: string,
  bullet: string,
  dateOverride?: string,
): UpdateResult {
  const date = dateOverride || todayDateUtc();
  const path = dailyLogPath(root, date);
  const normalized = assertBullet(bullet);
  return withFileLock(path, () => {
    const lines = ensureDailyLog(path, date);

    const span = findSection(lines, DAILY_ACTIVITY_SECTION);
    if (!span) {
      // ensureDailyLog just wrote the header, so this is a structural bug.
      throw new Error(`Daily log at ${path} is missing section: ${DAILY_ACTIVITY_SECTION}`);
    }

    const existing = new Set(bulletsInSpan(lines, span));
    if (existing.has(normalized)) {
      return { action: { kind: "noop", reason: "duplicate" }, file: path };
    }

    const insertAt = span.bodyEnd;
    const nextLines = [
      ...lines.slice(0, insertAt),
      normalized,
      ...lines.slice(insertAt),
    ];
    writeLines(path, nextLines);
    return { action: { kind: "added" }, file: path };
  });
}

export function isEditableFile(name: string): name is EditableFile {
  return name === MEMORY_FILE || name === PROJECT_FILE;
}

function matchesInSpan(lines: string[], span: SectionSpan, normalizedBullet: string): number[] {
  const out: number[] = [];
  for (let i = span.bodyStart; i < span.bodyEnd; i += 1) {
    const line = lines[i]!;
    if (!/^[-*+]\s+/.test(line.trim())) continue;
    if (normalizeBullet(line) === normalizedBullet) out.push(i);
  }
  return out;
}
