#!/usr/bin/env node
// CLI: copy sanitized add-rubrics proposal files into the trusted checkout.
// Env: RUBRICS_SOURCE_DIR, TRUSTED_RUBRICS_DIR

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const RUBRICS_DIR = "rubrics";
const README = "README.md";
const ALLOWLIST_MESSAGE =
  "Only rubrics/**/*.yml, rubrics/**/*.yaml, rubrics/**/.gitkeep, and top-level README.md may be committed";

class InvalidRubricProposalError extends Error {}

function invalidProposal(message: string): never {
  throw new InvalidRubricProposalError(message);
}

function isAllowedRubricsFile(path: string): boolean {
  const name = basename(path);
  const ext = extname(name);
  return name === ".gitkeep" || ext === ".yml" || ext === ".yaml";
}

function collectAllowedRubricsFiles(currentDir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const stat = lstatSync(fullPath);

    if (stat.isSymbolicLink()) {
      invalidProposal(`Unexpected symlink under rubrics/: ${fullPath}`);
    }

    if (stat.isDirectory()) {
      files.push(...collectAllowedRubricsFiles(fullPath));
      continue;
    }

    if (!stat.isFile()) continue;

    if (!isAllowedRubricsFile(fullPath)) {
      invalidProposal(`${ALLOWLIST_MESSAGE}; found ${fullPath}`);
    }

    files.push(fullPath);
  }

  return files;
}

export function prepareAddRubricsTrustedCopy(sourceDir: string, trustedDir: string): void {
  if (!sourceDir) invalidProposal("RUBRICS_SOURCE_DIR is required");
  if (!trustedDir) invalidProposal("TRUSTED_RUBRICS_DIR is required");

  const sourceRoot = resolve(sourceDir);
  const trustedRoot = resolve(trustedDir);
  const sourceRubricsRoot = join(sourceRoot, RUBRICS_DIR);

  mkdirSync(trustedRoot, { recursive: true });
  rmSync(join(trustedRoot, RUBRICS_DIR), { recursive: true, force: true });
  rmSync(join(trustedRoot, README), { force: true });

  if (existsSync(sourceRubricsRoot)) {
    const rubricsStat = lstatSync(sourceRubricsRoot);
    if (rubricsStat.isSymbolicLink()) {
      invalidProposal(`Unexpected symlink under rubrics/: ${sourceRubricsRoot}`);
    }

    if (rubricsStat.isDirectory()) {
      for (const sourceFile of collectAllowedRubricsFiles(sourceRubricsRoot)) {
        const relativePath = relative(sourceRoot, sourceFile);
        const destination = join(trustedRoot, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(sourceFile, destination);
      }
    }
  }

  const sourceReadme = join(sourceRoot, README);
  if (existsSync(sourceReadme)) {
    const readmeStat = lstatSync(sourceReadme);
    if (readmeStat.isSymbolicLink()) {
      invalidProposal("Top-level README.md must not be a symlink");
    }

    if (readmeStat.isFile()) {
      copyFileSync(sourceReadme, join(trustedRoot, README));
    }
  }
}

export function runPrepareAddRubricsTrustedCopyCli(env: NodeJS.ProcessEnv = process.env): number {
  try {
    prepareAddRubricsTrustedCopy(env.RUBRICS_SOURCE_DIR || "", env.TRUSTED_RUBRICS_DIR || "");
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof InvalidRubricProposalError) {
      console.error(`::error title=Invalid rubric proposal::${message}`);
    } else {
      console.error(message);
    }
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runPrepareAddRubricsTrustedCopyCli();
}
