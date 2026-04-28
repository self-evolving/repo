// Rubric storage and retrieval helpers.
//
// Rubrics are user/team-owned normative preferences, stored on a dedicated
// agent/rubrics branch. They are deliberately separate from agent memory:
// memory records context the agent learns; rubrics encode what users want the
// agent to optimize for and be reviewed against.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";

export const RUBRICS_SCHEMA_VERSION = 1;
export const RUBRICS_ROOT_DIR = "rubrics";
export const RUBRICS_README = "README.md";

export const RUBRIC_TYPES = ["generic", "specific"] as const;
export type RubricType = typeof RUBRIC_TYPES[number];

export const RUBRIC_DOMAINS = [
  "coding_style",
  "coding_workflow",
  "communication",
  "review_quality",
] as const;
export type RubricDomain = typeof RUBRIC_DOMAINS[number];

export const RUBRIC_SEVERITIES = ["must", "should", "consider"] as const;
export type RubricSeverity = typeof RUBRIC_SEVERITIES[number];

export const RUBRIC_STATUSES = ["active", "draft", "retired"] as const;
export type RubricStatus = typeof RUBRIC_STATUSES[number];

export const RUBRIC_ROUTE_NAMES = [
  "answer",
  "implement",
  "create-action",
  "fix-pr",
  "review",
  "skill",
  "rubrics-review",
  "rubrics-initialization",
  "rubrics-update",
] as const;
export type RubricRouteName = typeof RUBRIC_ROUTE_NAMES[number];

export interface RubricExample {
  source: string;
  note: string;
}

export interface Rubric {
  schema_version: number;
  id: string;
  title: string;
  description: string;
  type: RubricType;
  domain: RubricDomain;
  applies_to: RubricRouteName[];
  severity: RubricSeverity;
  weight: number;
  status: RubricStatus;
  examples: RubricExample[];
  path: string;
  absolutePath: string;
}

export interface RubricValidationError {
  path: string;
  message: string;
}

export interface RubricLoadResult {
  rubrics: Rubric[];
  errors: RubricValidationError[];
}

export interface RubricSelectionResult {
  rubric: Rubric;
  score: number;
  matchedTerms: string[];
}

export interface RubricSearchOptions {
  rootDir: string;
  route: string;
  query?: string;
  limit?: number;
  includeDraft?: boolean;
  allRoutes?: boolean;
  domains?: RubricDomain[];
}

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_LIMIT = 10;
const VALID_TYPE_SET = new Set<string>(RUBRIC_TYPES);
const VALID_DOMAIN_SET = new Set<string>(RUBRIC_DOMAINS);
const VALID_SEVERITY_SET = new Set<string>(RUBRIC_SEVERITIES);
const VALID_STATUS_SET = new Set<string>(RUBRIC_STATUSES);
const VALID_ROUTE_SET = new Set<string>(RUBRIC_ROUTE_NAMES);

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
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

export interface EnsureRubricsStructureResult {
  createdFiles: string[];
}

export function ensureRubricsStructure(rootDir: string, repoSlug: string): EnsureRubricsStructureResult {
  const createdFiles: string[] = [];
  const root = resolve(rootDir);

  for (const domain of ["coding", "communication", "workflow"] as const) {
    ensureDirectory(join(root, RUBRICS_ROOT_DIR, domain));
    ensureFile(join(root, RUBRICS_ROOT_DIR, domain, ".gitkeep"), "", createdFiles);
  }

  ensureFile(
    join(root, RUBRICS_README),
    [
      "# Agent rubrics",
      "",
      `This branch stores user/team-owned rubrics for ${repoSlug || "this repository"}.`,
      "",
      "Rubrics are normative preferences used to steer implementation and evaluate reviews.",
      "They are separate from `agent/memory`, which stores agent/project continuity.",
      "",
      "Each active rubric is a YAML file under `rubrics/`.",
      "",
    ].join("\n"),
    createdFiles,
  );

  return { createdFiles };
}

function collectYamlFiles(rootDir: string): string[] {
  const root = resolve(rootDir);
  const rubricsRoot = join(root, RUBRICS_ROOT_DIR);
  if (!existsSync(rubricsRoot)) return [];

  const out: string[] = [];
  const stack = [rubricsRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        stack.push(full);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (entry.isFile() && (ext === ".yaml" || ext === ".yml")) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function normalizeString(value: unknown): string {
  return String(value || "").trim();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizeString(entry)).filter(Boolean);
}

function normalizeExamples(value: unknown): RubricExample[] {
  if (!Array.isArray(value)) return [];
  const examples: RubricExample[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const source = normalizeString(record.source);
    const note = normalizeString(record.note);
    if (source || note) examples.push({ source, note });
  }
  return examples;
}

function parseRubricYaml(filePath: string, rootDir: string): Rubric {
  const raw = readFileSync(filePath, "utf8");
  const parsed = YAML.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("rubric YAML must be an object");
  }

  const schemaVersion = parsed.schema_version === undefined
    ? RUBRICS_SCHEMA_VERSION
    : Number(parsed.schema_version);
  const id = normalizeString(parsed.id);
  const title = normalizeString(parsed.title);
  const description = normalizeString(parsed.description);
  const type = normalizeString(parsed.type || "generic").toLowerCase();
  const rawDomain = normalizeString(parsed.domain || parsed.category || "coding_workflow").toLowerCase();
  const domain = rawDomain === "coding" ? "coding_workflow" : rawDomain;
  const severity = normalizeString(parsed.severity || "should").toLowerCase();
  const status = normalizeString(parsed.status || "active").toLowerCase();
  const appliesTo = normalizeStringArray(parsed.applies_to).map((route) => route.toLowerCase());
  const weight = parsed.weight === undefined ? 1 : Number(parsed.weight);

  if (schemaVersion !== RUBRICS_SCHEMA_VERSION) throw new Error(`schema_version must be ${RUBRICS_SCHEMA_VERSION}`);
  if (!id || !VALID_ID.test(id)) throw new Error("id must be kebab-case and start with a letter or digit");
  if (!title) throw new Error("title is required");
  if (!description) throw new Error("description is required");
  if (!VALID_TYPE_SET.has(type)) throw new Error(`type must be one of ${RUBRIC_TYPES.join(", ")}`);
  if (!VALID_DOMAIN_SET.has(domain)) throw new Error(`domain must be one of ${RUBRIC_DOMAINS.join(", ")}`);
  if (!VALID_SEVERITY_SET.has(severity)) throw new Error(`severity must be one of ${RUBRIC_SEVERITIES.join(", ")}`);
  if (!VALID_STATUS_SET.has(status)) throw new Error(`status must be one of ${RUBRIC_STATUSES.join(", ")}`);
  if (!Number.isInteger(weight) || weight < 1 || weight > 10) throw new Error("weight must be an integer from 1 to 10");
  if (appliesTo.length === 0) throw new Error("applies_to must contain at least one route");
  for (const route of appliesTo) {
    if (!VALID_ROUTE_SET.has(route)) throw new Error(`unsupported applies_to route: ${route}`);
  }

  return {
    schema_version: schemaVersion,
    id,
    title,
    description,
    type: type as RubricType,
    domain: domain as RubricDomain,
    applies_to: [...new Set(appliesTo)] as RubricRouteName[],
    severity: severity as RubricSeverity,
    weight,
    status: status as RubricStatus,
    examples: normalizeExamples(parsed.examples),
    path: toPosixPath(relative(resolve(rootDir), filePath)),
    absolutePath: filePath,
  };
}

export function loadRubrics(rootDir: string): RubricLoadResult {
  const files = collectYamlFiles(rootDir);
  const rubrics: Rubric[] = [];
  const errors: RubricValidationError[] = [];
  const seenIds = new Map<string, string>();

  for (const file of files) {
    try {
      const rubric = parseRubricYaml(file, rootDir);
      const previous = seenIds.get(rubric.id);
      if (previous) {
        errors.push({ path: rubric.path, message: `duplicate id ${rubric.id} also used by ${previous}` });
        continue;
      }
      seenIds.set(rubric.id, rubric.path);
      rubrics.push(rubric);
    } catch (err: unknown) {
      errors.push({
        path: toPosixPath(relative(resolve(rootDir), file)),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { rubrics: rubrics.sort((a, b) => a.id.localeCompare(b.id)), errors };
}

export function tokenizeRubricQuery(query: string): string[] {
  const seen = new Set<string>();
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 || /^[0-9]+$/.test(token))
    .filter((token) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });
}

function searchableText(rubric: Rubric): string {
  return [
    rubric.id,
    rubric.title,
    rubric.description,
    rubric.type,
    rubric.domain,
    rubric.severity,
    ...rubric.applies_to,
    ...rubric.examples.flatMap((example) => [example.source, example.note]),
  ].join("\n").toLowerCase();
}

function routeMatches(rubric: Rubric, route: string): boolean {
  const normalized = String(route || "").trim().toLowerCase();
  if (!normalized) return true;
  if (rubric.applies_to.includes(normalized as RubricRouteName)) return true;
  // Rubrics for implementation also apply to the PR-fix implementation path
  // unless the author chose a more specific route list.
  return normalized === "fix-pr" && rubric.applies_to.includes("implement");
}

function severityScore(severity: RubricSeverity): number {
  switch (severity) {
    case "must": return 30;
    case "should": return 20;
    case "consider": return 10;
  }
}

export function selectRubrics(options: RubricSearchOptions): { selected: RubricSelectionResult[]; errors: RubricValidationError[] } {
  const { rubrics, errors } = loadRubrics(options.rootDir);
  const tokens = tokenizeRubricQuery(options.query || "");
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const domainFilter = new Set(options.domains || []);
  const selected: RubricSelectionResult[] = [];

  for (const rubric of rubrics) {
    if (rubric.status === "retired") continue;
    if (rubric.status === "draft" && !options.includeDraft) continue;
    if (!options.allRoutes && !routeMatches(rubric, options.route)) continue;
    if (domainFilter.size > 0 && !domainFilter.has(rubric.domain)) continue;

    const text = searchableText(rubric);
    const matchedTerms: string[] = [];
    let score = severityScore(rubric.severity) + rubric.weight * 2;
    for (const token of tokens) {
      if (text.includes(token)) {
        matchedTerms.push(token);
        score += Math.max(token.length, 3) * 3;
      }
    }

    // With an empty or sparse query, active route-applicable rubrics are still
    // useful as baseline steering; rank by severity and weight.
    selected.push({ rubric, score, matchedTerms });
  }

  selected.sort((a, b) => b.score - a.score || b.rubric.weight - a.rubric.weight || a.rubric.id.localeCompare(b.rubric.id));
  return { selected: Number.isFinite(limit) ? selected.slice(0, limit) : selected, errors };
}

export function formatRubricsForPrompt(selected: RubricSelectionResult[]): string {
  if (selected.length === 0) {
    return "No active route-applicable rubrics were selected for this run.";
  }

  const lines: string[] = [];
  for (const entry of selected) {
    const rubric = entry.rubric;
    lines.push(`### ${rubric.title}`);
    lines.push(`- id: \`${rubric.id}\``);
    lines.push(`- domain/type: ${rubric.domain} / ${rubric.type}`);
    lines.push(`- severity/weight: ${rubric.severity} / ${rubric.weight}`);
    lines.push(`- applies to: ${rubric.applies_to.join(", ")}`);
    lines.push(`- source file: \`${rubric.path}\``);
    lines.push(`- rubric: ${rubric.description}`);
    if (entry.matchedTerms.length > 0) {
      lines.push(`- matched terms: ${entry.matchedTerms.join(", ")}`);
    }
    if (rubric.examples.length > 0) {
      const example = rubric.examples[0]!;
      lines.push(`- provenance: ${[example.source, example.note].filter(Boolean).join(" — ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
