import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentAssignee } from "./agent-assignee.js";
import { createIssue, ensureLabel, gh, postIssueComment } from "./github.js";
import { BUILT_IN_TRIGGER_LABELS } from "./trigger-labels.js";

const ONBOARDING_TITLE = "Sepo setup check";
const COMMENT_MARKER = "<!-- sepo-agent-onboarding-check -->";

export interface OnboardingOptions {
  repo: string;
  authMode: string;
  provider: string;
  providerReason: string;
  openaiConfigured: boolean;
  claudeConfigured: boolean;
  agentHandle: string;
  memoryRef: string;
  rubricsRef: string;
  runUrl: string;
  runnerTemp: string;
}

interface ExistingIssue {
  number: number;
  title: string;
}

interface ExistingComment {
  id: number;
  body: string;
}

function check(condition: boolean): string {
  return condition ? "[x]" : "[ ]";
}

function apiPath(repo: string, suffix: string): string {
  return `repos/${repo}/${suffix}`;
}

function branchExists(repo: string, branch: string): boolean {
  const ref = branch.trim();
  if (!ref) return false;

  const output = gh([
    "api",
    apiPath(repo, `git/matching-refs/heads/${ref}`),
    "--jq",
    ".[].ref",
  ]);
  return output.split(/\r?\n/).some((line) => line.trim() === `refs/heads/${ref}`);
}

function findExistingOnboardingIssue(repo: string): ExistingIssue | null {
  const output = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `${JSON.stringify(ONBOARDING_TITLE)} in:title`,
    "--json",
    "number,title",
  ]);
  const issues = JSON.parse(output) as ExistingIssue[];
  return issues.find((issue) => issue.title === ONBOARDING_TITLE) ?? null;
}

function createOnboardingIssue(opts: OnboardingOptions): number {
  const bodyFile = join(opts.runnerTemp, `sepo-onboarding-${randomBytes(8).toString("hex")}.md`);
  writeFileSync(bodyFile, issueBody(), "utf8");
  const issueUrl = createIssue({ title: ONBOARDING_TITLE, bodyFile, repo: opts.repo });
  const match = issueUrl.match(/(\d+)$/);
  if (!match) {
    throw new Error(`Could not parse issue number from ${issueUrl}`);
  }
  return Number.parseInt(match[1], 10);
}

function findOnboardingComment(repo: string, issueNumber: number): ExistingComment | null {
  const output = gh([
    "api",
    apiPath(repo, `issues/${issueNumber}/comments`),
  ]);
  const comments = JSON.parse(output) as ExistingComment[];
  return comments.find((comment) => comment.body.includes(COMMENT_MARKER)) ?? null;
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
  return `Use this issue to verify that Sepo is installed and ready in this repository.

Try a basic answer run:

\`\`\`md
@sepo-agent /answer Is Sepo configured correctly in this repository?
\`\`\`

Try implementation after setup:

\`\`\`md
@sepo-agent /implement Create a small README update that verifies the agent can open a PR.
\`\`\`

Try PR review on an open pull request:

\`\`\`md
@sepo-agent /review
\`\`\`
`;
}

function checklistBody(
  opts: OnboardingOptions,
  memoryReady: boolean,
  rubricsReady: boolean,
  assignee: { login: string; assignable: boolean; warning?: string },
): string {
  const providerConfigured = Boolean(opts.provider);
  const labelLines = BUILT_IN_TRIGGER_LABELS
    .map((label) => `- \`${label.name}\` -> \`${label.route}\``)
    .join("\n");
  const providerDetails = providerConfigured
    ? `${opts.provider} (${opts.providerReason || "configured"})`
    : "not configured";

  return `${COMMENT_MARKER}
## Sepo setup status

- ${check(Boolean(opts.authMode))} GitHub auth resolved: ${opts.authMode || "not resolved"}
- ${check(providerConfigured)} Agent provider resolved: ${providerDetails}
- ${check(assignee.assignable)} Agent handle assignable: \`${assignee.login || "unresolved"}\`${assignee.warning ? ` (${assignee.warning})` : ""}
- ${check(opts.openaiConfigured)} \`OPENAI_API_KEY\` configured
- ${check(opts.claudeConfigured)} \`CLAUDE_CODE_OAUTH_TOKEN\` configured
- ${check(memoryReady)} Memory branch exists: \`${opts.memoryRef}\`
- ${check(rubricsReady)} Rubrics branch exists: \`${opts.rubricsRef}\`
- [x] Built-in trigger labels ensured

Built-in trigger labels:

${labelLines}

Next steps:

1. Install the Sepo GitHub App or configure another auth path if GitHub auth used only the workflow token.
2. Configure at least one provider credential before running agent-backed routes.
3. Run \`Agent / Memory / Initialization\` if \`${opts.memoryRef}\` is missing.
4. Run \`Agent / Rubrics / Initialization\` if \`${opts.rubricsRef}\` is missing and you want team rubrics.

Last checked: ${opts.runUrl || "GitHub Actions"}
`;
}

export function runOnboardingCheck(opts: OnboardingOptions): number {
  for (const label of BUILT_IN_TRIGGER_LABELS) {
    ensureLabel({
      name: label.name,
      color: label.color,
      description: label.description,
      repo: opts.repo,
    });
  }

  const memoryReady = branchExists(opts.repo, opts.memoryRef);
  const rubricsReady = branchExists(opts.repo, opts.rubricsRef);
  const existingIssue = findExistingOnboardingIssue(opts.repo);
  const issueNumber = existingIssue?.number ?? createOnboardingIssue(opts);
  const assignee = resolveAgentAssignee({
    agentHandle: opts.agentHandle,
    repo: opts.repo,
  });
  const body = checklistBody(opts, memoryReady, rubricsReady, assignee);
  const existingComment = findOnboardingComment(opts.repo, issueNumber);

  if (existingComment) {
    updateIssueComment(opts.repo, existingComment.id, body);
  } else {
    postIssueComment(issueNumber, body, opts.repo);
  }

  return issueNumber;
}
