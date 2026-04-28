// CLI: create a GitHub issue, optionally with an origin-link footer.
// Usage: node .agent/dist/cli/create-issue.js
// Env: ISSUE_TITLE, ISSUE_BODY, SOURCE_KIND (optional), TARGET_URL (optional)
// Outputs: issue_number, issue_url
//
// When SOURCE_KIND and TARGET_URL are set, appends a footer pointing back
// to the origin (e.g. "Requested via issue_comment at <url>"). Callers
// without an origin can omit those env vars.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createIssue } from "../github.js";
import { setOutput } from "../output.js";

const MAX_TITLE_LENGTH = 70;

function normalizeTitle(raw: string): string {
  const collapsed = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "Agent-created issue";
  }
  if (collapsed.length > MAX_TITLE_LENGTH) {
    return `${collapsed.slice(0, MAX_TITLE_LENGTH - 3)}...`;
  }
  return collapsed;
}

const title = normalizeTitle(process.env.ISSUE_TITLE || "");
const rawBody = process.env.ISSUE_BODY || "";
const sourceKind = process.env.SOURCE_KIND || "";
const targetUrl = process.env.TARGET_URL || "";

const bodyLines: string[] = [rawBody];
if (targetUrl) {
  bodyLines.push("", "---", "", `Requested via ${sourceKind || "mention"} at ${targetUrl}`);
}

const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
const bodyFile = join(runnerTemp, `agent-issue-body-${randomBytes(8).toString("hex")}.md`);
writeFileSync(bodyFile, bodyLines.join("\n") + "\n", "utf8");

const issueUrl = createIssue({ title, bodyFile });
const numberMatch = issueUrl.match(/(\d+)$/);
const issueNumber = numberMatch ? numberMatch[1] : "";

setOutput("issue_url", issueUrl);
setOutput("issue_number", issueNumber);
console.log(`Issue created: ${issueUrl}`);
