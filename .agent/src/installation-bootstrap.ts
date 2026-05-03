import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, dispatchWorkflow, gh, postIssueComment } from "./github.js";
import { setupIssueBody } from "./onboarding.js";

const ONBOARDING_WORKFLOW = "agent-onboarding.yml";
const SETUP_ISSUE_TITLE = "Sepo setup check";
const BOOTSTRAP_MARKER = "<!-- sepo-agent-installation-bootstrap -->";

export interface InstallationBootstrapOptions {
  repo: string;
  ref: string;
  installationId: string;
  runUrl: string;
  runnerTemp: string;
}

export interface InstallationBootstrapResult {
  status: "dispatched" | "fallback_issue";
  issueNumber: number | null;
  reason: string;
}

interface ExistingIssue {
  number: number;
  title: string;
}

interface ExistingComment {
  id: number;
  body: string;
}

type WorkflowLookupResult =
  | { status: "exists" }
  | { status: "missing" }
  | { status: "error"; reason: string };

function apiPath(repo: string, suffix: string): string {
  return `repos/${repo}/${suffix}`;
}

function commandErrorText(err: unknown): string {
  const record = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [record.message, record.stderr, record.stdout]
    .map((part) => {
      if (Buffer.isBuffer(part)) return part.toString("utf8");
      return typeof part === "string" ? part : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isMissingWorkflowFileError(err: unknown): boolean {
  const text = commandErrorText(err);
  return /\bHTTP 404\b/i.test(text) && /not found/i.test(text);
}

function workflowFileLookupErrorReason(err: unknown): string {
  const text = commandErrorText(err);
  return text ? `Workflow lookup failed: ${text}` : "Workflow lookup failed.";
}

function lookupWorkflowFile(repo: string, ref: string): WorkflowLookupResult {
  try {
    gh([
      "api",
      "--method",
      "GET",
      apiPath(repo, `contents/.github/workflows/${ONBOARDING_WORKFLOW}`),
      "-f",
      `ref=${ref}`,
    ]);
    return { status: "exists" };
  } catch (err: unknown) {
    if (isMissingWorkflowFileError(err)) return { status: "missing" };
    return { status: "error", reason: workflowFileLookupErrorReason(err) };
  }
}

function isExistingComment(value: unknown): value is ExistingComment {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { id?: unknown; body?: unknown };
  return typeof record.id === "number" && typeof record.body === "string";
}

function flattenCommentPages(value: unknown): ExistingComment[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (Array.isArray(item)) return item.filter(isExistingComment);
    return isExistingComment(item) ? [item] : [];
  });
}

function parseComments(output: string): ExistingComment[] {
  return flattenCommentPages(JSON.parse(output) as unknown);
}

function findExistingSetupIssue(repo: string): ExistingIssue | null {
  const output = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `${JSON.stringify(SETUP_ISSUE_TITLE)} in:title`,
    "--json",
    "number,title",
  ]);
  const issues = JSON.parse(output) as ExistingIssue[];
  return issues.find((issue) => issue.title === SETUP_ISSUE_TITLE) ?? null;
}

function createSetupIssue(opts: InstallationBootstrapOptions): number {
  const bodyFile = join(opts.runnerTemp, `sepo-install-bootstrap-${randomBytes(8).toString("hex")}.md`);
  writeFileSync(bodyFile, setupIssueBody(), "utf8");
  const issueUrl = createIssue({ title: SETUP_ISSUE_TITLE, bodyFile, repo: opts.repo });
  const match = issueUrl.match(/(\d+)$/);
  if (!match) {
    throw new Error(`Could not parse issue number from ${issueUrl}`);
  }
  return Number.parseInt(match[1], 10);
}

function findBootstrapComment(repo: string, issueNumber: number): ExistingComment | null {
  const output = gh([
    "api",
    "--paginate",
    "--slurp",
    apiPath(repo, `issues/${issueNumber}/comments`),
  ]);
  const comments = parseComments(output);
  return comments.find((comment) => comment.body.includes(BOOTSTRAP_MARKER)) ?? null;
}

function updateIssueComment(repo: string, commentId: number, body: string): void {
  gh([
    "api",
    "-X",
    "PATCH",
    apiPath(repo, `issues/comments/${commentId}`),
    "-f",
    `body=${body}`,
  ]);
}

function fallbackComment(opts: InstallationBootstrapOptions, reason: string): string {
  const installationLine = opts.installationId
    ? `GitHub App installation: \`${opts.installationId}\``
    : "GitHub App installation: unavailable";
  const runLine = opts.runUrl ? `Bootstrap run: ${opts.runUrl}` : "Bootstrap run: hosted Sepo App";
  const reasonLine = reason.replace(/\s+/g, " ").trim().slice(0, 500);

  return `${BOOTSTRAP_MARKER}
## Sepo installation bootstrap

The Sepo GitHub App was installed, but automatic onboarding did not start.

- Repository: \`${opts.repo}\`
- Default ref: \`${opts.ref}\`
- ${installationLine}
- ${runLine}
- Reason: ${reasonLine || "automatic onboarding could not start"}

Next steps:

1. Confirm this repository contains \`.github/workflows/${ONBOARDING_WORKFLOW}\` on \`${opts.ref}\`.
2. Enable GitHub Actions for the repository.
3. Confirm the Sepo GitHub App has \`Actions: write\` and \`Issues: write\`.
4. Configure \`OPENAI_API_KEY\` or \`CLAUDE_CODE_OAUTH_TOKEN\` as a repository secret.
5. Run \`Agent / Onboarding / Check Setup\` from GitHub Actions.
`;
}

function createOrUpdateFallbackIssue(opts: InstallationBootstrapOptions, reason: string): number {
  const existingIssue = findExistingSetupIssue(opts.repo);
  const issueNumber = existingIssue?.number ?? createSetupIssue(opts);
  const body = fallbackComment(opts, reason);
  const existingComment = findBootstrapComment(opts.repo, issueNumber);

  if (existingComment) {
    updateIssueComment(opts.repo, existingComment.id, body);
  } else {
    postIssueComment(issueNumber, body, opts.repo);
  }

  return issueNumber;
}

export function runInstallationBootstrap(opts: InstallationBootstrapOptions): InstallationBootstrapResult {
  const repo = opts.repo.trim();
  const ref = opts.ref.trim();
  if (!repo) throw new Error("repo is required");
  if (!ref) throw new Error("ref is required");

  const normalized = { ...opts, repo, ref };
  const workflowLookup = lookupWorkflowFile(repo, ref);
  if (workflowLookup.status === "missing") {
    const reason = `\`${ONBOARDING_WORKFLOW}\` was not found on \`${ref}\`.`;
    const issueNumber = createOrUpdateFallbackIssue(normalized, reason);
    return { status: "fallback_issue", issueNumber, reason };
  }
  if (workflowLookup.status === "error") {
    const issueNumber = createOrUpdateFallbackIssue(normalized, workflowLookup.reason);
    return { status: "fallback_issue", issueNumber, reason: workflowLookup.reason };
  }

  try {
    dispatchWorkflow(repo, ONBOARDING_WORKFLOW, ref, {});
    return { status: "dispatched", issueNumber: null, reason: "onboarding workflow dispatched" };
  } catch (err: unknown) {
    const text = commandErrorText(err);
    const reason = text
      ? `Workflow dispatch failed: ${text}`
      : "Workflow dispatch failed.";
    const issueNumber = createOrUpdateFallbackIssue(normalized, reason);
    return { status: "fallback_issue", issueNumber, reason };
  }
}
