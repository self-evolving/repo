// CLI: dispatch agent-implement.yml with the standard input contract.
// Usage: node .agent/dist/cli/dispatch-agent-implement.js
// Env: GITHUB_REPOSITORY, DEFAULT_BRANCH, ISSUE_NUMBER, REQUESTED_BY,
//      REQUEST_TEXT, APPROVAL_COMMENT_URL, SESSION_FORK_FROM_THREAD_KEY,
//      BASE_BRANCH, BASE_PR, IMPLEMENTATION_ROUTE, IMPLEMENTATION_PROMPT,
//      TARGET_KIND, TARGET_NUMBER, AUTOMATION_MODE, AUTOMATION_MAX_ROUNDS

import { dispatchWorkflow } from "../github.js";
import { resolveImplementationBaseHint } from "../implementation-base-hint.js";

const repo = process.env.GITHUB_REPOSITORY || "";
const ref = process.env.DEFAULT_BRANCH || "";
const issueNumber = process.env.ISSUE_NUMBER || "";
const requestedBy = process.env.REQUESTED_BY || "";
const requestText = process.env.REQUEST_TEXT || "";
const approvalCommentUrl = process.env.APPROVAL_COMMENT_URL || "";
const sessionForkFromThreadKey = process.env.SESSION_FORK_FROM_THREAD_KEY || "";
const baseBranch = process.env.BASE_BRANCH || "";
const basePr = process.env.BASE_PR || "";
const targetKind = process.env.TARGET_KIND || "";
const targetNumber = process.env.TARGET_NUMBER || "";
const implementationRoute = process.env.IMPLEMENTATION_ROUTE || "implement";
const implementationPrompt = process.env.IMPLEMENTATION_PROMPT || implementationRoute;
const automationMode = process.env.AUTOMATION_MODE || "disabled";
const automationMaxRounds = process.env.AUTOMATION_MAX_ROUNDS || "12";
const baseHint = resolveImplementationBaseHint({
  requestText,
  targetKind,
  targetNumber,
  baseBranch,
  basePr,
});

if (!repo || !ref || !issueNumber) {
  console.error("Missing required env: GITHUB_REPOSITORY, DEFAULT_BRANCH, ISSUE_NUMBER");
  process.exitCode = 2;
} else {
  dispatchWorkflow(repo, "agent-implement.yml", ref, {
    issue_number: issueNumber,
    requested_by: requestedBy,
    approval_comment_url: approvalCommentUrl,
    request_text: requestText,
    session_fork_from_thread_key: sessionForkFromThreadKey,
    base_branch: baseHint.baseBranch,
    base_pr: baseHint.basePr,
    implementation_route: implementationRoute,
    implementation_prompt: implementationPrompt,
    automation_mode: automationMode,
    automation_max_rounds: automationMaxRounds,
  });
  if (baseHint.source === "stacked_request") {
    console.log(`Derived base_pr #${baseHint.basePr} from stacked PR request`);
  }
  console.log(`Dispatched agent-implement.yml for ${implementationRoute} issue #${issueNumber}`);
}
