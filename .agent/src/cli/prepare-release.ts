// CLI: create or reuse the tracking issue for a manual release prepare run.
// Usage: node .agent/dist/cli/prepare-release.js
// Env: GITHUB_REPOSITORY, VERSION, REQUESTED_BY, RUNNER_TEMP
// Outputs: issue_number, issue_url, request_text, version

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createIssue, gh } from "../github.js";
import { setOutput } from "../output.js";
import { parseReleaseVersion } from "../release-version.js";

interface ListedIssue {
  number?: number;
  title?: string;
  url?: string;
}

function normalizeVersion(raw: string): string {
  const value = raw.trim();
  return value ? parseReleaseVersion(value).version : "";
}

function issueTitle(version: string): string {
  return version ? `Prepare Sepo release ${version}` : "Prepare next Sepo release";
}

function issueBody(version: string, requestedBy: string): string {
  const request = version
    ? `Prepare the Sepo ${version} release pull request.`
    : "Determine and prepare the next Sepo release pull request.";
  return [
    "## Goal",
    request,
    "",
    "## Acceptance criteria",
    "- Keep `.agent/package.json` as the canonical Sepo package/runtime version.",
    "- Validate the release version against `.agent/docs/technical-details/versioning.md`.",
    "- Update `.agent/package-lock.json` if package metadata changes require it.",
    "- Update `.agent/CHANGELOG.md` with release notes for the version.",
    "- Update docs or checklist content changed by this release.",
    "- Open a pull request.",
    "- Do not create git tags, GitHub Releases, or package publications.",
    "",
    `Requested by: ${requestedBy || "workflow_dispatch"}`,
    "",
    `<!-- sepo-agent-release-prepare version:${version || "next"} -->`,
  ].join("\n");
}

function requestText(version: string): string {
  return version
    ? `Prepare the Sepo ${version} release pull request.`
    : "Determine and prepare the next Sepo release pull request.";
}

function findOpenIssue(repo: string, title: string): ListedIssue | null {
  const raw = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    title,
    "--json",
    "number,title,url",
  ]);
  const issues = JSON.parse(raw) as ListedIssue[];
  return issues.find((issue) => issue.title === title && issue.number && issue.url) || null;
}

function createReleaseIssue(repo: string, title: string, version: string, requestedBy: string): ListedIssue | null {
  const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
  const bodyFile = join(runnerTemp, `release-prepare-${randomBytes(8).toString("hex")}.md`);
  writeFileSync(bodyFile, issueBody(version, requestedBy) + "\n", "utf8");
  const url = createIssue({ title, bodyFile, repo });
  const numberMatch = url.match(/\/issues\/(\d+)$/);
  if (!numberMatch) {
    console.error(`Could not parse created release prepare issue number from URL: ${url || "(empty)"}`);
    process.exitCode = 1;
    return null;
  }
  return { number: Number.parseInt(numberMatch[1], 10), title, url };
}

const repo = process.env.GITHUB_REPOSITORY || "";
const requestedBy = process.env.REQUESTED_BY || "";
const version = normalizeVersion(process.env.VERSION || "");

if (!repo) {
  console.error("Missing required env: GITHUB_REPOSITORY");
  process.exitCode = 2;
} else {
  const title = issueTitle(version);
  const existing = findOpenIssue(repo, title);
  const issue = existing || createReleaseIssue(repo, title, version, requestedBy);

  if (issue) {
    setOutput("issue_number", String(issue.number || ""));
    setOutput("issue_url", issue.url || "");
    setOutput("issue_action", existing ? "reused" : "created");
    setOutput("request_text", requestText(version));
    setOutput("version", version);

    console.log(`${existing ? "Reused" : "Created"} release prepare issue: ${issue.url}`);
  }
}
