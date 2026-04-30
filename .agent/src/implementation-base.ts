import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fetchPrMeta } from "./github.js";
import { setOutput } from "./output.js";

export interface ResolveImplementationBaseOptions {
  baseBranch?: string;
  basePr?: string;
  defaultBranch: string;
  repo?: string;
}

export interface ResolvedImplementationBase {
  baseBranch: string;
  source: "default_branch" | "base_branch" | "base_pr";
  basePr?: number;
}

function normalizeInput(value: string | undefined): string {
  return String(value || "").trim();
}

export function validateBaseBranch(value: string): string {
  const branch = normalizeInput(value);
  if (!branch) {
    throw new Error("base branch is required");
  }
  if (branch.startsWith("-")) {
    throw new Error("base branch must not start with '-'");
  }
  if (
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith(".") ||
    branch === "@" ||
    branch.includes("@{") ||
    /(^|\/)\./.test(branch) ||
    /(^|\/)[^/]+\.lock(\/|$)/.test(branch) ||
    /[\s~^:?*[\]\\\x00-\x1f\x7f]/.test(branch)
  ) {
    throw new Error(`invalid base branch: ${branch}`);
  }
  return branch;
}

function parseBasePr(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("base_pr must be a positive integer");
  }
  return Number.parseInt(value, 10);
}

export function resolveImplementationBase(
  opts: ResolveImplementationBaseOptions,
): ResolvedImplementationBase {
  const explicitBranch = normalizeInput(opts.baseBranch);
  const explicitPr = normalizeInput(opts.basePr);
  const defaultBranch = validateBaseBranch(opts.defaultBranch);

  if (explicitBranch && explicitPr) {
    throw new Error("set only one of base_branch or base_pr");
  }

  if (explicitBranch) {
    return {
      baseBranch: validateBaseBranch(explicitBranch),
      source: "base_branch",
    };
  }

  if (explicitPr) {
    const basePr = parseBasePr(explicitPr);
    const meta = fetchPrMeta(basePr, opts.repo);
    if (meta.isCrossRepository) {
      throw new Error(`base_pr #${basePr} is from a fork; only same-repository PR heads are supported`);
    }
    if (meta.state.toUpperCase() !== "OPEN") {
      throw new Error(`base_pr #${basePr} must be open`);
    }
    return {
      baseBranch: validateBaseBranch(meta.headRef),
      source: "base_pr",
      basePr,
    };
  }

  return {
    baseBranch: defaultBranch,
    source: "default_branch",
  };
}

function appendGithubEnv(name: string, value: string): void {
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) return;
  const delim = `DELIM_${randomBytes(8).toString("hex")}`;
  appendFileSync(envFile, `${name}<<${delim}\n${value}\n${delim}\n`);
}

export function exportImplementationBase(result: ResolvedImplementationBase): void {
  appendGithubEnv("BASE_BRANCH", result.baseBranch);
  setOutput("base_branch", result.baseBranch);
  setOutput("source", result.source);
  setOutput("base_pr", result.basePr ? String(result.basePr) : "");
}
