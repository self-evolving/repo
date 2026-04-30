// CLI: create or annotate a child issue for sub-orchestration.
// Env: GITHUB_REPOSITORY, PARENT_ISSUE_NUMBER, CHILD_ISSUE_NUMBER, STAGE,
//      TASK_INSTRUCTIONS, BASE_BRANCH, BASE_PR, PARENT_ROUND
// Outputs: child_issue_number

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gh } from "../github.js";
import { setOutput } from "../output.js";
import {
  formatSubOrchestrationIssueBody,
  normalizeSubOrchestratorStage,
  parseSubOrchestratorMarker,
} from "../sub-orchestration.js";

function positiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseIssueNumberFromUrl(url: string): string {
  const match = String(url || "").trim().match(/\/issues\/(\d+)(?:\D*)?$/);
  return match ? match[1] : "";
}

function withBodyFile<T>(body: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sepo-sub-orchestrator-"));
  try {
    const path = join(dir, "body.md");
    writeFileSync(path, body, "utf8");
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const repo = process.env.GITHUB_REPOSITORY || "";
const parentIssue = positiveInt(process.env.PARENT_ISSUE_NUMBER || "");
const existingChildIssue = positiveInt(process.env.CHILD_ISSUE_NUMBER || "");
const stage = process.env.STAGE || "stage";
const taskInstructions = process.env.TASK_INSTRUCTIONS || "";
const baseBranch = process.env.BASE_BRANCH || "";
const basePr = process.env.BASE_PR || "";
const parentRound = positiveInt(process.env.PARENT_ROUND || "");

if (!repo || !parentIssue) {
  console.error("Missing required env: GITHUB_REPOSITORY, PARENT_ISSUE_NUMBER");
  process.exit(2);
}
if (baseBranch && basePr) {
  console.error("Set only one of BASE_BRANCH or BASE_PR");
  process.exit(2);
}

if (existingChildIssue) {
  const raw = gh([
    "issue",
    "view",
    String(existingChildIssue),
    "--repo",
    repo,
    "--json",
    "body",
  ]).trim();
  const body = String((JSON.parse(raw || "{}") as Record<string, unknown>).body || "");
  const marker = parseSubOrchestratorMarker(body);
  const expectedStage = normalizeSubOrchestratorStage(stage);
  if (!marker) {
    console.error(`Child issue #${existingChildIssue} is missing a sepo-sub-orchestrator marker`);
    process.exit(2);
  }
  if (marker.parent !== parentIssue || marker.stage !== expectedStage || marker.state !== "running") {
    console.error(`Child issue #${existingChildIssue} is not a running child for parent #${parentIssue} stage ${expectedStage}`);
    process.exit(2);
  }
  setOutput("child_issue_number", String(existingChildIssue));
  console.log(`Using existing child issue #${existingChildIssue}`);
  process.exit(0);
}

const body = formatSubOrchestrationIssueBody({
  parentIssue,
  stage,
  taskInstructions,
  baseBranch,
  basePr,
  parentRound: parentRound || undefined,
});
const url = withBodyFile(body, (bodyFile) => gh([
  "issue",
  "create",
  "--repo",
  repo,
  "--title",
  `Sub-orchestrator: ${stage}`,
  "--body-file",
  bodyFile,
]).trim());
const childIssueNumber = parseIssueNumberFromUrl(url);
if (!childIssueNumber) {
  console.error(`Could not parse created child issue URL: ${url}`);
  process.exit(2);
}
setOutput("child_issue_number", childIssueNumber);
console.log(`Created child issue #${childIssueNumber}`);
