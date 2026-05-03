import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, dispatchWorkflow, gh, postIssueComment } from "./github.js";

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

function workflowFileExists(repo: string, ref: string): boolean {
  try {
    gh([
      "api",
      "--method",
      "GET",
      apiPath(repo, `contents/.github/workflows/${ONBOARDING_WORKFLOW}`),
      "-f",
      `ref=${ref}`,
    ]);
    return true;
  } catch {
    return false;
  }
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
  writeFileSync(bodyFile, issueBody(), "utf8");
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
    apiPath(repo, `issues/${issueNumber}/comments`),
  ]);
  const comments = JSON.parse(output) as ExistingComment[];
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

function issueBody(): string {
  return `Use this issue to finish Sepo installation for this repository.

The Sepo GitHub App tried to start onboarding automatically. If the status
comment below says the onboarding workflow could not be dispatched, follow the
listed next steps and rerun \`Agent / Onboarding / Check Setup\` manually.
`;
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
  if (!workflowFileExists(repo, ref)) {
    const reason = `\`${ONBOARDING_WORKFLOW}\` was not found on \`${ref}\`.`;
    const issueNumber = createOrUpdateFallbackIssue(normalized, reason);
    return { status: "fallback_issue", issueNumber, reason };
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
