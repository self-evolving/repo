import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addIssueLabel, createIssue, ensureLabel, gh, postIssueComment } from "./github.js";
import { BUILT_IN_TRIGGER_LABELS } from "./trigger-labels.js";

const ONBOARDING_TITLE = "Sepo setup check";
const COMMENT_MARKER = "<!-- sepo-agent-onboarding-check -->";
const SEPO_APP_INSTALL_URL = "https://github.com/apps/sepo-agent-app/installations/select_target";
const SEPO_SETUP_GUIDE_URL = "https://github.com/self-evolving/repo/blob/main/.agent/docs/setup/setup-guide.md";
const AGENT_STATUS_LABEL = {
  name: "agent",
  color: "0e8a16",
  description: "Handled by the agent",
};
const REPOSITORY_MANAGEMENT_LABELS = [
  AGENT_STATUS_LABEL,
  {
    name: "agent-goal",
    color: "5319e7",
    description: "Marks an issue as a repository-level goal for Sepo planning",
  },
];

export interface OnboardingOptions {
  repo: string;
  authMode: string;
  provider: string;
  providerReason: string;
  openaiConfigured: boolean;
  claudeConfigured: boolean;
  anthropicConfigured: boolean;
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

interface OnboardingLinks {
  actionsSecretsUrl: string;
  memoryWorkflowUrl: string;
  rubricsWorkflowUrl: string;
  onboardingWorkflowUrl: string;
}

function apiPath(repo: string, suffix: string): string {
  return `repos/${repo}/${suffix}`;
}

function githubRepoUrl(repo: string): string {
  const [owner = "", name = ""] = repo.trim().split("/");
  if (!owner || !name) return "";
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function onboardingLinks(repo: string): OnboardingLinks {
  const repoUrl = githubRepoUrl(repo);
  if (!repoUrl) {
    return {
      actionsSecretsUrl: "",
      memoryWorkflowUrl: "",
      rubricsWorkflowUrl: "",
      onboardingWorkflowUrl: "",
    };
  }

  return {
    actionsSecretsUrl: `${repoUrl}/settings/secrets/actions`,
    memoryWorkflowUrl: `${repoUrl}/actions/workflows/agent-memory-bootstrap.yml`,
    rubricsWorkflowUrl: `${repoUrl}/actions/workflows/agent-rubrics-initialization.yml`,
    onboardingWorkflowUrl: `${repoUrl}/actions/workflows/agent-onboarding.yml`,
  };
}

function link(label: string, url: string): string {
  return url ? `[${label}](${url})` : label;
}

function workflowActionLink(label: string, url: string): string {
  return link(`Actions > ${label}`, url);
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
  const bodyFile = writeOnboardingIssueBody(opts);
  const issueUrl = createIssue({ title: ONBOARDING_TITLE, bodyFile, repo: opts.repo });
  const match = issueUrl.match(/(\d+)$/);
  if (!match) {
    throw new Error(`Could not parse issue number from ${issueUrl}`);
  }
  return Number.parseInt(match[1], 10);
}

function updateOnboardingIssueBody(opts: OnboardingOptions, issueNumber: number): void {
  const bodyFile = writeOnboardingIssueBody(opts);
  gh(["issue", "edit", String(issueNumber), "--repo", opts.repo, "--body-file", bodyFile]);
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
  return `Use this issue to track Sepo setup for this repository.

The latest setup status is maintained in the comment below.
`;
}

function writeOnboardingIssueBody(opts: OnboardingOptions): string {
  const bodyFile = join(opts.runnerTemp, `sepo-onboarding-${randomBytes(8).toString("hex")}.md`);
  writeFileSync(bodyFile, issueBody(), "utf8");
  return bodyFile;
}

function authStatusBody(opts: OnboardingOptions): string {
  const authMode = opts.authMode;
  const resolvedMode = authMode.trim();
  if (resolvedMode) {
    return `- [x] GitHub App/auth: resolved via \`${resolvedMode}\``;
  }

  return [
    "- [ ] GitHub App/auth: not resolved",
    `  - ${link("Install the Sepo GitHub App", SEPO_APP_INSTALL_URL)} or choose another auth path from the ${link("setup guide", SEPO_SETUP_GUIDE_URL)}.`,
  ].join("\n");
}

function credentialNames(opts: OnboardingOptions): string[] {
  const names: string[] = [];
  if (opts.openaiConfigured) names.push("`OPENAI_API_KEY`");
  if (opts.claudeConfigured) names.push("`CLAUDE_CODE_OAUTH_TOKEN`");
  if (opts.anthropicConfigured) names.push("`ANTHROPIC_API_KEY`");
  return names;
}

function andList(items: string[]): string {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function providerDetailBody(opts: OnboardingOptions): string[] {
  const provider = opts.provider.trim();
  if (!provider) return [];

  const reason = opts.providerReason.trim();
  return [`  - Agent provider: \`${provider}\`${reason ? ` (${reason})` : ""}`];
}

function modelStatusBody(opts: OnboardingOptions, links: OnboardingLinks): string {
  const names = credentialNames(opts);
  if (names.length === 0) {
    return [
      "- [ ] Model credentials: not configured",
      `  - Add \`OPENAI_API_KEY\`, \`CLAUDE_CODE_OAUTH_TOKEN\`, or \`ANTHROPIC_API_KEY\` in ${link("repository Actions secrets", links.actionsSecretsUrl)}.`,
      "  - Optional: configure `AGENT_DEFAULT_PROVIDER`.",
      ...providerDetailBody(opts),
    ].join("\n");
  }

  return [
    `- [x] Model credentials: ${andList(names)} configured`,
    ...providerDetailBody(opts),
  ].join("\n");
}

function branchStatusBody(
  label: string,
  ref: string,
  ready: boolean,
  actionName: string,
  actionUrl: string,
  optional = false,
): string {
  if (ready) {
    return `- [x] ${label}: initialized (\`${ref}\`)`;
  }

  const prefix = optional ? "Optional: run" : "Run";
  return [
    `- [ ] ${label}: not initialized`,
    `  - ${prefix} **${workflowActionLink(actionName, actionUrl)}**.`,
  ].join("\n");
}

function remainingSetupBody(
  opts: OnboardingOptions,
  memoryReady: boolean,
  rubricsReady: boolean,
  links: OnboardingLinks,
): string {
  const items: string[] = [];
  if (!opts.authMode.trim()) {
    items.push(`${link("Install the Sepo GitHub App", SEPO_APP_INSTALL_URL)} or choose another auth path from the ${link("setup guide", SEPO_SETUP_GUIDE_URL)}.`);
  }
  if (credentialNames(opts).length === 0) {
    items.push(`Configure one model provider credential in ${link("repository Actions secrets", links.actionsSecretsUrl)}.`);
  }
  if (!memoryReady) {
    items.push(`Run ${link("Agent / Memory / Initialization", links.memoryWorkflowUrl)} to initialize memory branch \`${opts.memoryRef}\`.`);
  }
  if (!rubricsReady) {
    items.push(`Optional: run ${link("Agent / Rubrics / Initialization", links.rubricsWorkflowUrl)} to initialize rubrics branch \`${opts.rubricsRef}\`.`);
  }

  if (items.length === 0) {
    return "- [x] Required setup is complete.";
  }

  return items.map((item) => `- [ ] ${item}`).join("\n");
}

function checklistBody(opts: OnboardingOptions, memoryReady: boolean, rubricsReady: boolean): string {
  const links = onboardingLinks(opts.repo);
  const lastChecked = opts.runUrl
    ? link("GitHub Actions run", opts.runUrl)
    : link("GitHub Actions", links.onboardingWorkflowUrl);

  return `${COMMENT_MARKER}
## Sepo setup status

### Current status

${authStatusBody(opts)}
${modelStatusBody(opts, links)}
${branchStatusBody("Memory", opts.memoryRef, memoryReady, "Agent / Memory / Initialization", links.memoryWorkflowUrl)}
${branchStatusBody("Rubrics", opts.rubricsRef, rubricsReady, "Agent / Rubrics / Initialization", links.rubricsWorkflowUrl, true)}

### Remaining setup

${remainingSetupBody(opts, memoryReady, rubricsReady, links)}

### Test Sepo

After setup, try:

\`\`\`md
@sepo-agent /answer Is Sepo configured correctly in this repository?
\`\`\`

Try implementation:

\`\`\`md
@sepo-agent /implement Create a small README update that verifies the agent can open a PR.
\`\`\`

On an open pull request:

\`\`\`md
@sepo-agent /review
\`\`\`

Last checked: ${lastChecked}
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
  for (const label of REPOSITORY_MANAGEMENT_LABELS) {
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
  if (existingIssue) {
    updateOnboardingIssueBody(opts, issueNumber);
  }
  addIssueLabel(issueNumber, AGENT_STATUS_LABEL.name, opts.repo);
  const body = checklistBody(opts, memoryReady, rubricsReady);
  const existingComment = findOnboardingComment(opts.repo, issueNumber);

  if (existingComment) {
    updateIssueComment(opts.repo, existingComment.id, body);
  } else {
    postIssueComment(issueNumber, body, opts.repo);
  }

  return issueNumber;
}
