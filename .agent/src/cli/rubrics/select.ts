#!/usr/bin/env node
// CLI: select route-applicable rubrics and render them as markdown.
// Usage: node .agent/dist/cli/rubrics/select.js --dir <dir> --route implement --query "..."

import { writeFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolve } from "node:path";
import {
  formatRubricsForPrompt,
  RUBRIC_DOMAINS,
  type RubricDomain,
  selectRubrics,
} from "../../rubrics.js";
import { setOutput } from "../../output.js";

const ARG_CONFIG = {
  options: {
    dir: { type: "string" },
    route: { type: "string" },
    query: { type: "string" },
    limit: { type: "string" },
    domains: { type: "string" },
    "include-draft": { type: "boolean" },
    "all-routes": { type: "boolean" },
    "best-effort": { type: "boolean" },
    "output-file": { type: "string" },
  },
  allowPositionals: true,
  strict: true,
} as const satisfies ParseArgsConfig;

function parseLimit(value: string | undefined): number | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "all") return Number.POSITIVE_INFINITY;
  const n = Number(value || "");
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseDomains(value: string | undefined): RubricDomain[] {
  const valid = new Set<string>(RUBRIC_DOMAINS);
  const seen = new Set<RubricDomain>();
  const domains: RubricDomain[] = [];
  for (const entry of String(value || "").split(",")) {
    const domain = entry.trim().toLowerCase();
    if (!domain) continue;
    if (!valid.has(domain)) {
      throw new Error(`--domains entries must be one of ${RUBRIC_DOMAINS.join(", ")}`);
    }
    if (!seen.has(domain as RubricDomain)) {
      seen.add(domain as RubricDomain);
      domains.push(domain as RubricDomain);
    }
  }
  return domains;
}

export function runRubricsSelectCli(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  let parsed: ReturnType<typeof parseArgs<typeof ARG_CONFIG>>;
  try {
    parsed = parseArgs({ ...ARG_CONFIG, args: argv });
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const values = parsed.values as {
    dir?: string;
    route?: string;
    query?: string;
    limit?: string;
    domains?: string;
    "include-draft"?: boolean;
    "all-routes"?: boolean;
    "best-effort"?: boolean;
    "output-file"?: string;
  };
  const dir = resolve(values.dir || env.RUBRICS_DIR || process.cwd());
  const route = values.route || env.ROUTE || "";
  const query = values.query || parsed.positionals.join(" ") || env.REQUEST_TEXT || "";
  const outputFile = values["output-file"] || env.RUBRICS_CONTEXT_FILE || "";
  let domains: RubricDomain[] = [];
  try {
    domains = parseDomains(values.domains || env.RUBRICS_SELECT_DOMAINS);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const { selected, errors } = selectRubrics({
    rootDir: dir,
    route,
    query,
    limit: parseLimit(values.limit || env.RUBRICS_LIMIT),
    includeDraft: Boolean(values["include-draft"]),
    allRoutes: Boolean(values["all-routes"]),
    domains,
  });

  setOutput("selected_count", String(selected.length));
  setOutput("rubric_error_count", String(errors.length));

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`::warning file=${error.path},title=Invalid rubric::${error.message}`);
    }
    if (!values["best-effort"]) return 1;
  }

  const rendered = formatRubricsForPrompt(selected);
  if (outputFile) {
    writeFileSync(outputFile, rendered, "utf8");
    setOutput("context_file", outputFile);
  }
  process.stdout.write(rendered);
  return 0;
}

if (require.main === module) {
  process.exitCode = runRubricsSelectCli(process.argv.slice(2));
}
