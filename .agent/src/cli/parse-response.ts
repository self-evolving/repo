// CLI: parse agent response and determine run status.
// Usage: node .agent/dist/cli/parse-response.js
// Env: RESPONSE_FILE, AGENT_EXIT_CODE, HAS_CHANGES, VERIFY_EXIT_CODE, HEAD_CHANGED
// Outputs: status, summary, commit_message, pr_title, pr_body

import { readFileSync } from "node:fs";
import {
  determineRunStatus,
  normalizeImplementationResponse,
} from "../response.js";
import { setOutput } from "../output.js";

const agentExit = Number(process.env.AGENT_EXIT_CODE || "0");
const hasChanges = process.env.HAS_CHANGES === "true";
const headChanged = process.env.HEAD_CHANGED === "true";
const verifyExit = Number(process.env.VERIFY_EXIT_CODE || "0");
const responseFile = process.env.RESPONSE_FILE || "";

const status = determineRunStatus(agentExit, hasChanges, verifyExit, headChanged);
setOutput("status", status);

let raw = "";
if (responseFile) {
  try { raw = readFileSync(responseFile, "utf8"); } catch { /* ok */ }
}

const response = normalizeImplementationResponse(raw);
setOutput("summary", response.summary);
setOutput("commit_message", response.commitMessage);
setOutput("pr_title", response.prTitle);
setOutput("pr_body", response.prBody);
