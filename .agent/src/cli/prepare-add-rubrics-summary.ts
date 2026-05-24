// CLI: build the add-rubrics summary comment body.
// Usage: node .agent/dist/cli/prepare-add-rubrics-summary.js
// Env: RESPONSE_FILE, RUBRICS_COMMITTED, RUBRICS_REF, RUBRICS_TARGET_REF,
//      RUBRICS_PROPOSAL_REF, RUBRICS_WRITE_MODE, RUBRIC_PR_ACTION,
//      RUBRIC_PR_OUTCOME, RUBRIC_PR_URL, RUBRICS_STEP_OUTCOME,
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
const rubricsTargetRef = process.env.RUBRICS_TARGET_REF || "";
const rubricsProposalRef = process.env.RUBRICS_PROPOSAL_REF || "";
const writeMode = process.env.RUBRICS_WRITE_MODE || "proposal_pr";
const proposalPrAction = process.env.RUBRIC_PR_ACTION || "";
const proposalPrOutcome = process.env.RUBRIC_PR_OUTCOME || "";
const proposalPrUrl = process.env.RUBRIC_PR_URL || "";
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
const proposalPrSucceeded =
  writeMode === "proposal_pr" && rubricsCommitted && proposalPrOutcome === "failure"
    ? false
    : undefined;

const body = formatAddRubricsComment({
  targetKind,
  targetNumber,
  rubricsRef,
  rubricsTargetRef,
  writeMode,
  rubricsCommitted,
  runSucceeded,
  persistenceSucceeded,
  proposalPrSucceeded,
  proposalPrAction,
  proposalPrUrl,
  proposalBranch: rubricsProposalRef,
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
