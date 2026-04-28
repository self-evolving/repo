// CLI: build the rubrics-update summary comment body.
// Usage: node .agent/dist/cli/prepare-rubrics-update-summary.js
// Env: RESPONSE_FILE, RUBRICS_COMMITTED, RUBRICS_STEP_OUTCOME, RUBRICS_REF,
//      PR_NUMBER, RUNNER_TEMP
// Outputs: body_file

import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { formatRubricsUpdateComment } from "../response.js";
import { setOutput } from "../output.js";

const responseFile = process.env.RESPONSE_FILE || "";
const rubricsCommitted = process.env.RUBRICS_COMMITTED === "true";
const runSucceeded = process.env.RUBRICS_STEP_OUTCOME === "success";
const rubricsRef = process.env.RUBRICS_REF || "agent/rubrics";
const prNumber = process.env.PR_NUMBER || "";

let summary = "";
if (responseFile) {
  try {
    summary = readFileSync(responseFile, "utf8");
  } catch {
    console.error(`Could not read response file: ${responseFile}`);
  }
}

const body = formatRubricsUpdateComment({
  prNumber,
  rubricsRef,
  rubricsCommitted,
  runSucceeded,
  summary,
});

const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
const bodyFile = join(
  runnerTemp,
  `rubrics-update-summary-${randomBytes(8).toString("hex")}.md`,
);
writeFileSync(bodyFile, body + "\n", "utf8");
setOutput("body_file", bodyFile);
