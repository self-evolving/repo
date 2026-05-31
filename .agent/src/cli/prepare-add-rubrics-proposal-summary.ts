// CLI: prepare the user-facing summary for add-rubrics proposal runs.
// Env: BODY_FILE, RESPONSE_FILE, RUBRICS_REF, RUBRICS_COMMITTED,
//      RUBRICS_VALIDATION_OUTCOME, RUBRICS_STEP_OUTCOME, PR_URL, BRANCH
// Outputs: body_file

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeImplementationResponse } from "../response.js";
import { setOutput } from "../output.js";

function readOptional(path: string): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const explicitBodyFile = process.env.BODY_FILE || "";
const responseFile = process.env.RESPONSE_FILE || "";
const rubricsRef = process.env.RUBRICS_REF || "agent/rubrics";
const rubricsCommitted = process.env.RUBRICS_COMMITTED === "true";
const validationOutcome = process.env.RUBRICS_VALIDATION_OUTCOME || "";
const stepOutcome = process.env.RUBRICS_STEP_OUTCOME || "";
const prUrl = process.env.PR_URL || "";
const branch = process.env.BRANCH || "";

const parsed = normalizeImplementationResponse(readOptional(responseFile));
const lines = ["## Rubrics Proposal", ""];

if (stepOutcome && stepOutcome !== "success") {
  lines.push("Rubric proposal generation did not complete successfully; inspect the workflow logs.");
} else if (validationOutcome === "failure") {
  lines.push(`Rubric proposal edits failed validation for \`${rubricsRef}\`; no pull request was opened.`);
} else if (rubricsCommitted && prUrl) {
  lines.push(`Opened a rubric proposal pull request targeting \`${rubricsRef}\`.`);
  if (branch) lines.push(`- Branch: \`${branch}\``);
  lines.push(`- Pull request: ${prUrl}`);
} else {
  lines.push(`No rubric proposal changes were committed for \`${rubricsRef}\`.`);
}

if (parsed.summary) {
  lines.push("", parsed.summary);
}

const body = `${lines.join("\n").trim()}\n`;
const bodyFile = explicitBodyFile || join(mkdtempSync(join(tmpdir(), "add-rubrics-summary-")), "body.md");
writeFileSync(bodyFile, body, "utf8");
setOutput("body_file", bodyFile);
