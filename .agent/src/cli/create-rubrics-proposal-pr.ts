// CLI: create or reuse a rubric proposal pull request.
// Usage: node .agent/dist/cli/create-rubrics-proposal-pr.js
// Env: BRANCH, BASE_BRANCH, RESPONSE_FILE, TARGET_KIND, TARGET_NUMBER,
//      TARGET_URL, REQUESTED_BY, GITHUB_REPOSITORY, GH_TOKEN
// Outputs: pr_url, pr_number, pr_action

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { createPr, findExistingPr, gh } from "../github.js";
import { setOutput } from "../output.js";

const branch = process.env.BRANCH || "";
const baseBranch = process.env.BASE_BRANCH || "agent/rubrics";
const repo = process.env.GITHUB_REPOSITORY || "";
const responseFile = process.env.RESPONSE_FILE || "";
const targetKind = process.env.TARGET_KIND || "target";
const targetNumber = process.env.TARGET_NUMBER || "";
const targetUrl = process.env.TARGET_URL || "";
const requestedBy = process.env.REQUESTED_BY || "";

function parsePrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)(?:[/?#].*)?$/);
  return match ? match[1] : "";
}

function readSummary(): string {
  if (!responseFile) return "";
  try {
    return readFileSync(responseFile, "utf8").trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not read add-rubrics response file ${responseFile}: ${msg}`);
    return "";
  }
}

function targetLabel(): string {
  const number = String(targetNumber || "").trim();
  return number ? `${targetKind} #${number}` : targetKind;
}

if (!branch) {
  throw new Error("Missing rubric proposal branch");
}

const title = `Propose rubric updates from ${targetLabel()}`;
const summary = readSummary();
const body = [
  "## Rubric Proposal",
  "",
  `- Source: ${targetUrl || targetLabel()}`,
  `- Base: \`${baseBranch}\``,
  `- Proposal branch: \`${branch}\``,
  requestedBy ? `- Requested by: @${requestedBy}` : "",
  "",
  "## Agent Summary",
  "",
  summary || "No summary was produced.",
].filter(Boolean).join("\n");

const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
const bodyFile = join(runnerTemp, `rubrics-proposal-pr-${randomBytes(8).toString("hex")}.md`);
writeFileSync(bodyFile, body + "\n", "utf8");

const existing = findExistingPr(branch, repo);
if (existing) {
  let action = "existing";
  try {
    gh(["pr", "edit", existing, "--title", title, "--body-file", bodyFile]);
    action = "updated";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not update existing rubric proposal PR ${existing}: ${msg}`);
  }
  setOutput("pr_url", existing);
  setOutput("pr_number", parsePrNumber(existing));
  setOutput("pr_action", action);
  console.log(`Rubric proposal PR found: ${existing}`);
  process.exit(0);
}

const prUrl = createPr({
  base: baseBranch,
  head: branch,
  title,
  bodyFile,
  repo,
});

setOutput("pr_url", prUrl);
setOutput("pr_number", parsePrNumber(prUrl));
setOutput("pr_action", "created");
console.log(`Rubric proposal PR created: ${prUrl}`);
