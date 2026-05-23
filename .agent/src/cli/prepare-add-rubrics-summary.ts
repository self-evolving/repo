// CLI: build the add-rubrics summary comment body.
// Usage: node .agent/dist/cli/prepare-add-rubrics-summary.js
// Env: RESPONSE_FILE, RUBRICS_COMMITTED, RUBRICS_REF, RUBRICS_STEP_OUTCOME,
//      RUBRICS_VALIDATION_OUTCOME, RUBRICS_COMMIT_OUTCOME, TARGET_KIND,
//      TARGET_NUMBER, GITHUB_REPOSITORY
// Outputs: body_file

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { formatAddRubricsComment } from "../response.js";
import { setOutput } from "../output.js";

const responseFile = process.env.RESPONSE_FILE || "";
const rubricsCommitted = process.env.RUBRICS_COMMITTED === "true";
const runSucceeded = process.env.RUBRICS_STEP_OUTCOME === "success";
const rubricsRef = process.env.RUBRICS_REF || "agent/rubrics";
const validationOutcome = process.env.RUBRICS_VALIDATION_OUTCOME || "";
const commitOutcome = process.env.RUBRICS_COMMIT_OUTCOME || "";
const repoSlug = process.env.GITHUB_REPOSITORY || "";
const targetKind = process.env.TARGET_KIND || "";
const targetNumber = process.env.TARGET_NUMBER || "";

let summary = "";
if (responseFile) {
  try {
    summary = readFileSync(responseFile, "utf8").trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Could not read add-rubrics response file ${responseFile}: ${msg}`);
  }
}

const persistenceSucceeded =
  validationOutcome === "failure" || commitOutcome === "failure"
    ? false
    : undefined;

const body = formatAddRubricsComment({
  targetKind,
  targetNumber,
  rubricsRef,
  rubricsCommitted,
  runSucceeded,
  persistenceSucceeded,
  repoSlug,
  summary,
});

const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
const bodyFile = join(
  runnerTemp,
  `add-rubrics-summary-${randomBytes(8).toString("hex")}.md`,
);
writeFileSync(bodyFile, body + "\n", "utf8");
setOutput("body_file", bodyFile);
