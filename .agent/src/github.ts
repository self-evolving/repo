// GitHub API helpers for workflow post-processing steps.
//
// These functions wrap gh CLI operations that workflows perform: posting
// comments, creating PRs, fetching metadata, dispatching workflows.

import { execFileSync } from "node:child_process";

export const MAX_BUFFER = 10 * 1024 * 1024;

export function gh(args: string[], cwd?: string): string {
  return execFileSync("gh", args, {
    cwd,
    stdio: "pipe",
    maxBuffer: MAX_BUFFER,
  }).toString("utf8");
}

/**
 * Runs `gh api <args>` and returns trimmed stdout. Returns "" on any
 * non-zero exit. Use for best-effort lookups where a 404 is an expected
 * answer (e.g. "is this user a collaborator?").
 */
export function ghApi(args: string[]): string {
  try {
    return gh(["api", ...args]).trim();
  } catch {
    return "";
  }
}

/**
 * Returns true if `gh api <args>` exits 0. Use for endpoints that return
 * 204 on success (no body) and 404 on absence, where `ghApi` can't
 * distinguish the two.
 */
export function ghApiOk(args: string[]): boolean {
  try {
    gh(["api", ...args]);
    return true;
  } catch {
    return false;
  }
}

// --- Comments ---

export function postIssueComment(issueNumber: number, body: string, repo?: string): void {
  const args = ["issue", "comment", String(issueNumber), "--body", body];
  if (repo) args.push("--repo", repo);
  gh(args);
}

export function postPrComment(prNumber: number, body: string, repo?: string): void {
  const args = ["pr", "comment", String(prNumber), "--body", body];
  if (repo) args.push("--repo", repo);
  gh(args);
}

// --- Labels ---

export interface EnsureLabelOptions {
  name: string;
  color: string;
  description: string;
  repo?: string;
}

function commandErrorText(err: unknown): string {
  const record = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [record.message, record.stderr, record.stdout]
    .map((part) => {
      if (Buffer.isBuffer(part)) return part.toString("utf8");
      return typeof part === "string" ? part : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isAlreadyExistsLabelError(err: unknown): boolean {
  return /already exists|already_exists|name has already been taken/i.test(commandErrorText(err));
}

export function ensureLabel(opts: EnsureLabelOptions): void {
  const name = opts.name.trim();
  if (!name) return;

  const listArgs = ["label", "list", "--search", name, "--json", "name", "--jq", ".[].name"];
  if (opts.repo) listArgs.push("--repo", opts.repo);

  const existing = gh(listArgs)
    .split(/\r?\n/)
    .some((line) => line.trim() === name);
  if (existing) return;

  const createArgs = [
    "label",
    "create",
    name,
    "--color",
    opts.color,
    "--description",
    opts.description,
  ];
  if (opts.repo) createArgs.push("--repo", opts.repo);

  try {
    gh(createArgs);
  } catch (err: unknown) {
    if (!isAlreadyExistsLabelError(err)) throw err;
  }
}

export function addIssueLabel(issueNumber: number, label: string, repo?: string): void {
  const args = ["issue", "edit", String(issueNumber), "--add-label", label];
  if (repo) args.push("--repo", repo);
  gh(args);
}

export function addPrLabel(prNumber: number, label: string, repo?: string): void {
  const args = ["pr", "edit", String(prNumber), "--add-label", label];
  if (repo) args.push("--repo", repo);
  gh(args);
}

// --- Pull requests ---

export interface PrMeta {
  headRef: string;
  headOid: string;
  isCrossRepository: boolean;
  state: string;
}

export function fetchPrMeta(prNumber: number, repo?: string): PrMeta {
  const args = ["pr", "view", String(prNumber), "--json", "headRefName,headRefOid,isCrossRepository,state"];
  if (repo) args.push("--repo", repo);
  const data = JSON.parse(gh(args));
  return {
    headRef: String(data.headRefName ?? ""),
    headOid: String(data.headRefOid ?? ""),
    isCrossRepository: Boolean(data.isCrossRepository),
    state: String(data.state ?? ""),
  };
}

export function findExistingPr(headBranch: string, repo?: string): string | null {
  const args = ["pr", "list", "--head", headBranch, "--json", "url", "--jq", ".[0].url // empty"];
  if (repo) args.push("--repo", repo);
  const url = gh(args).trim();
  return url || null;
}

export interface CreatePrOptions {
  base: string;
  head: string;
  title: string;
  bodyFile: string;
  draft?: boolean;
  repo?: string;
}

export function createPr(opts: CreatePrOptions): string {
  const args = ["pr", "create"];
  if (opts.draft) args.push("--draft");
  args.push("--base", opts.base, "--head", opts.head, "--title", opts.title, "--body-file", opts.bodyFile);
  if (opts.repo) args.push("--repo", opts.repo);
  return gh(args).trim();
}

// --- Issues ---

export interface CreateIssueOptions {
  title: string;
  bodyFile: string;
  repo?: string;
}

export function createIssue(opts: CreateIssueOptions): string {
  const args = ["issue", "create", "--title", opts.title, "--body-file", opts.bodyFile];
  if (opts.repo) args.push("--repo", opts.repo);
  return gh(args).trim();
}

// --- Workflow dispatch ---

function dispatchWorkflowPayload(repo: string, workflow: string, ref: string, inputs: Record<string, string>): void {
  const payload = JSON.stringify({ ref, inputs });
  execFileSync("gh", [
    "api", "-X", "POST",
    `repos/${repo}/actions/workflows/${workflow}/dispatches`,
    "--input", "-",
  ], {
    input: payload,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: MAX_BUFFER,
  });
}

function parseUnexpectedWorkflowInputs(err: unknown): string[] {
  const match = commandErrorText(err).match(/Unexpected inputs provided:\s*(\[[^\]]*\])/i);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function dispatchWorkflow(
  repo: string,
  workflow: string,
  ref: string,
  inputs: Record<string, string>,
): void {
  try {
    dispatchWorkflowPayload(repo, workflow, ref, inputs);
    return;
  } catch (err: unknown) {
    const unexpectedInputs = parseUnexpectedWorkflowInputs(err);
    if (unexpectedInputs.length === 0) throw err;

    const retryInputs = { ...inputs };
    let removed = 0;
    for (const name of unexpectedInputs) {
      if (Object.prototype.hasOwnProperty.call(retryInputs, name)) {
        delete retryInputs[name];
        removed += 1;
      }
    }
    if (removed === 0) throw err;

    console.warn(
      `Retrying ${workflow} dispatch without unsupported input(s): ${unexpectedInputs.join(", ")}`,
    );
    dispatchWorkflowPayload(repo, workflow, ref, retryInputs);
  }
}
