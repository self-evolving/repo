#!/usr/bin/env node
// CLI: seed the default rubric branch layout.
// Usage: node .agent/dist/cli/rubrics/init.js --dir <dir> --repo <owner/repo>

import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolve } from "node:path";
import { ensureRubricsStructure } from "../../rubrics.js";

const ARG_CONFIG = {
  options: {
    dir: { type: "string" },
    repo: { type: "string" },
  },
  allowPositionals: false,
  strict: true,
} as const satisfies ParseArgsConfig;

export function runRubricsInitCli(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  let values: { dir?: string; repo?: string };
  try {
    values = parseArgs({ ...ARG_CONFIG, args: argv }).values as typeof values;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const dir = resolve(values.dir || env.RUBRICS_DIR || process.cwd());
  const repo = values.repo || env.REPO_SLUG || env.GITHUB_REPOSITORY || "";
  if (!repo) {
    console.error("Missing repository slug. Pass --repo or set REPO_SLUG/GITHUB_REPOSITORY.");
    return 1;
  }

  const result = ensureRubricsStructure(dir, repo);
  console.log(JSON.stringify({ dir, repo, createdFiles: result.createdFiles }, null, 2));
  return 0;
}

if (require.main === module) {
  process.exitCode = runRubricsInitCli(process.argv.slice(2));
}
