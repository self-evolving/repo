#!/usr/bin/env node
// CLI: validate rubric YAML files.
// Usage: node .agent/dist/cli/rubrics/validate.js --dir <dir>

import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolve } from "node:path";
import { loadRubrics } from "../../rubrics.js";
import { setOutput } from "../../output.js";

const ARG_CONFIG = {
  options: {
    dir: { type: "string" },
  },
  allowPositionals: false,
  strict: true,
} as const satisfies ParseArgsConfig;

export function runRubricsValidateCli(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  let values: { dir?: string };
  try {
    values = parseArgs({ ...ARG_CONFIG, args: argv }).values as typeof values;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const dir = resolve(values.dir || env.RUBRICS_DIR || process.cwd());
  const { rubrics, errors } = loadRubrics(dir);
  setOutput("rubric_count", String(rubrics.length));
  setOutput("rubric_error_count", String(errors.length));

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`${error.path}: ${error.message}`);
    }
    return 1;
  }

  console.log(`validated ${rubrics.length} rubric${rubrics.length === 1 ? "" : "s"} in ${dir}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = runRubricsValidateCli(process.argv.slice(2));
}
