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
import { createIssue, findOpenIssueByTitle } from "../github.js";
import { setOutput } from "../output.js";
import { parseReleaseVersion } from "../release-version.js";

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
const route = String(process.env.ROUTE || "").trim().toLowerCase();
const repo = process.env.GITHUB_REPOSITORY || undefined;

function releaseVersionFromTitle(rawTitle: string): string {
  const match = String(rawTitle || "").match(/\brelease\s+([^\s]+)\s*$/i);
  if (!match) return "";
  try {
    return parseReleaseVersion(match[1]).version;
  } catch {
    return "";
  }
}

const bodyLines: string[] = [rawBody];
if (targetUrl) {
  bodyLines.push("", "---", "", `Requested via ${sourceKind || "mention"} at ${targetUrl}`);
}
const releaseVersion = route === "release" ? releaseVersionFromTitle(title) : "";
const issueTitle = releaseVersion ? `Prepare Sepo release ${releaseVersion}` : title;
if (releaseVersion) {
  bodyLines.push("", `<!-- sepo-agent-release-prep version:${releaseVersion} -->`);
}

const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
const bodyFile = join(runnerTemp, `agent-issue-body-${randomBytes(8).toString("hex")}.md`);
writeFileSync(bodyFile, bodyLines.join("\n") + "\n", "utf8");

const existingIssue = releaseVersion ? findOpenIssueByTitle(issueTitle, repo) : null;
if (existingIssue) {
  setOutput("issue_url", existingIssue.url);
  setOutput("issue_number", String(existingIssue.number));
  setOutput("issue_action", "reused");
  console.log(`Issue reused: ${existingIssue.url}`);
  process.exit(0);
}

const issueUrl = createIssue({ title: issueTitle, bodyFile, repo });
const numberMatch = issueUrl.match(/(\d+)$/);
const issueNumber = numberMatch ? numberMatch[1] : "";

setOutput("issue_url", issueUrl);
setOutput("issue_number", issueNumber);
setOutput("issue_action", "created");
console.log(`Issue created: ${issueUrl}`);
