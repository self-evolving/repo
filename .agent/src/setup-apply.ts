import { gh, postIssueComment } from "./github.js";

export const SETUP_APPLY_COMMENT_MARKER = "<!-- sepo-agent-setup-apply -->";

export const SETUP_VARIABLE_ALLOWLIST = [
  "AGENT_HANDLE",
  "AGENT_ASSIGNMENT_ENABLED",
  "AGENT_PROJECT_MANAGEMENT_ENABLED",
  "AGENT_PROJECT_MANAGEMENT_DRY_RUN",
  "AGENT_PROJECT_MANAGEMENT_APPLY_LABELS",
  "AGENT_PROJECT_MANAGEMENT_PROJECT_ID",
  "AGENT_PROJECT_MANAGEMENT_PROJECT_URL",
  "AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER",
  "AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE",
] as const;

type SetupVariableName = (typeof SETUP_VARIABLE_ALLOWLIST)[number];

export type ProjectManagementMode = "off" | "dry-run" | "project-backed";

export interface SetupIssueIntent {
  agentHandle: string;
  assignToAgent: boolean;
  projectManagementMode: ProjectManagementMode;
  githubProjectChoice: "none" | "create" | "link";
  projectOwner: string;
  projectTitle: string;
  projectStatuses: string[];
  priorityField: string;
  effortField: string;
  releaseField: string;
  releaseValues: string[];
  setupNotes: string;
  projectUrl: string;
  projectId: string;
  confirmationChecked: boolean;
}

export interface SetupVariableChange {
  name: SetupVariableName;
  currentValue: string | null;
  nextValue: string;
  action: "create" | "update" | "unchanged";
}

export interface SetupVariablePlan {
  changes: SetupVariableChange[];
  errors: string[];
  warnings: string[];
}

interface ExistingComment {
  id: number;
  body: string;
}

const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const PROJECT_URL_PATTERN = /^https:\/\/github\.com\/(orgs\/[^/]+|users\/[^/]+)\/projects\/[0-9]+([/?#].*)?$/;

function normalizeSectionName(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function cleanIssueFormValue(value: string): string {
  const trimmed = String(value || "").trim();
  return trimmed === "_No response_" ? "" : trimmed;
}

function firstNonEmptyLine(value: string): string {
  return cleanIssueFormValue(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function splitNonEmptyLines(value: string): string[] {
  return cleanIssueFormValue(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseIssueFormSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current = "";
  let buffer: string[] = [];

  function flush(): void {
    if (!current) return;
    sections.set(current, cleanIssueFormValue(buffer.join("\n")));
  }

  for (const line of String(body || "").split(/\r?\n/)) {
    const match = line.match(/^###\s+(.+?)\s*$/);
    if (match) {
      flush();
      current = normalizeSectionName(match[1]);
      buffer = [];
    } else if (current) {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

function parseAssignToAgent(value: string): boolean {
  const normalized = firstNonEmptyLine(value).toLowerCase();
  return normalized.startsWith("yes");
}

function parseProjectManagementMode(value: string): ProjectManagementMode {
  const normalized = firstNonEmptyLine(value).toLowerCase();
  if (normalized === "off" || normalized === "dry-run" || normalized === "project-backed") {
    return normalized;
  }
  return "dry-run";
}

function parseGithubProjectChoice(value: string): SetupIssueIntent["githubProjectChoice"] {
  const normalized = firstNonEmptyLine(value).toLowerCase();
  if (normalized.includes("create")) return "create";
  if (normalized.includes("link")) return "link";
  return "none";
}

function setupConfirmationsChecked(value: string): boolean {
  const checked = String(value || "")
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*\[[xX]\]/.test(line)).length;
  return checked >= 2;
}

function trimTrailingPunctuation(value: string): string {
  return value.trim().replace(/[),.;]+$/g, "");
}

function extractProjectUrl(text: string): string {
  const match = String(text || "").match(/https:\/\/github\.com\/(?:orgs\/[^/\s]+|users\/[^/\s]+)\/projects\/[0-9]+(?:[/?#][^\s)]*)?/i);
  return match ? trimTrailingPunctuation(match[0]) : "";
}

function extractProjectId(text: string): string {
  const patterns = [
    /\bAGENT_PROJECT_MANAGEMENT_PROJECT_ID\s*[:=]\s*`?([A-Za-z0-9_:-]+)`?/i,
    /\bProject\s+(?:node\s+)?ID\s*[:=]\s*`?([A-Za-z0-9_:-]+)`?/i,
  ];
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1]) return trimTrailingPunctuation(match[1]);
  }
  return "";
}

export function parseSetupIssueIntent(body: string): SetupIssueIntent {
  const sections = parseIssueFormSections(body);
  const setupNotes = sections.get("additional setup notes") || "";

  return {
    agentHandle: firstNonEmptyLine(sections.get("agent handle") || ""),
    assignToAgent: parseAssignToAgent(sections.get("assign accepted work to the agent") || ""),
    projectManagementMode: parseProjectManagementMode(sections.get("project management mode") || ""),
    githubProjectChoice: parseGithubProjectChoice(sections.get("github project") || ""),
    projectOwner: firstNonEmptyLine(sections.get("project owner") || ""),
    projectTitle: firstNonEmptyLine(sections.get("project title") || ""),
    projectStatuses: splitNonEmptyLines(sections.get("project status values") || ""),
    priorityField: firstNonEmptyLine(sections.get("priority field") || ""),
    effortField: firstNonEmptyLine(sections.get("effort field") || ""),
    releaseField: firstNonEmptyLine(sections.get("release field") || ""),
    releaseValues: splitNonEmptyLines(sections.get("release values") || ""),
    setupNotes,
    projectUrl: extractProjectUrl(setupNotes),
    projectId: extractProjectId(setupNotes),
    confirmationChecked: setupConfirmationsChecked(sections.get("setup confirmation") || ""),
  };
}

function hasUnsafeMarkup(value: string): boolean {
  return value.includes("<!--") || value.includes("-->");
}

function validateAgentHandle(value: string): string | null {
  if (!value) return "Agent handle is required.";
  if (!value.startsWith("@")) return "Agent handle must start with @.";
  if (/\s/.test(value)) return "Agent handle must not contain whitespace.";
  if (value.length > 100) return "Agent handle is too long.";
  if (hasUnsafeMarkup(value)) return "Agent handle must not contain HTML comment markers.";
  return null;
}

function validateProjectOwner(value: string): string | null {
  if (!value) return null;
  return GITHUB_LOGIN_PATTERN.test(value)
    ? null
    : "Project owner must be a GitHub user or organization login.";
}

function validateProjectTitle(value: string): string | null {
  if (!value) return null;
  if (value.length > 100) return "Project title must be 100 characters or fewer.";
  if (/[\r\n]/.test(value)) return "Project title must be a single line.";
  if (hasUnsafeMarkup(value)) return "Project title must not contain HTML comment markers.";
  return null;
}

function validateProjectUrl(value: string): string | null {
  if (!value) return null;
  return PROJECT_URL_PATTERN.test(value)
    ? null
    : "Project URL must be a GitHub Project URL such as https://github.com/orgs/OWNER/projects/1.";
}

function validateProjectId(value: string): string | null {
  if (!value) return null;
  if (/\s/.test(value)) return "Project ID must not contain whitespace.";
  if (hasUnsafeMarkup(value)) return "Project ID must not contain HTML comment markers.";
  if (value.length > 200) return "Project ID is too long.";
  return null;
}

function pushIfError(errors: string[], error: string | null): void {
  if (error) errors.push(error);
}

function validateIntent(intent: SetupIssueIntent): string[] {
  const errors: string[] = [];
  if (!intent.confirmationChecked) {
    errors.push("Both setup confirmation checkboxes must be checked before `/setup apply`.");
  }
  pushIfError(errors, validateAgentHandle(intent.agentHandle));
  pushIfError(errors, validateProjectOwner(intent.projectOwner));
  pushIfError(errors, validateProjectTitle(intent.projectTitle));
  pushIfError(errors, validateProjectUrl(intent.projectUrl));
  pushIfError(errors, validateProjectId(intent.projectId));

  if (intent.projectManagementMode === "project-backed") {
    if (intent.githubProjectChoice === "none") {
      errors.push("Project-backed mode requires the setup issue to create or link a GitHub Project.");
    }
    if (!intent.projectUrl && !intent.projectId && (!intent.projectOwner || !intent.projectTitle)) {
      errors.push("Project-backed mode requires a Project URL/ID in setup notes or both Project owner and title.");
    }
  }

  return errors;
}

function validateVariableValue(name: SetupVariableName, value: string): string | null {
  if (name === "AGENT_HANDLE") return validateAgentHandle(value);
  if (
    name === "AGENT_ASSIGNMENT_ENABLED" ||
    name === "AGENT_PROJECT_MANAGEMENT_ENABLED" ||
    name === "AGENT_PROJECT_MANAGEMENT_DRY_RUN" ||
    name === "AGENT_PROJECT_MANAGEMENT_APPLY_LABELS"
  ) {
    return value === "true" || value === "false" ? null : `${name} must be true or false.`;
  }
  if (name === "AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER") return validateProjectOwner(value);
  if (name === "AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE") return validateProjectTitle(value);
  if (name === "AGENT_PROJECT_MANAGEMENT_PROJECT_URL") return validateProjectUrl(value);
  if (name === "AGENT_PROJECT_MANAGEMENT_PROJECT_ID") return validateProjectId(value);
  return `${name} is not an allowlisted setup variable.`;
}

function addDesiredVariable(
  desired: Map<SetupVariableName, string>,
  name: SetupVariableName,
  value: string,
): void {
  const normalized = String(value || "").trim();
  if (normalized) {
    desired.set(name, normalized);
  }
}

function changeFor(
  name: SetupVariableName,
  nextValue: string,
  currentVariables: Map<string, string>,
): SetupVariableChange {
  const currentValue = currentVariables.has(name) ? currentVariables.get(name) ?? "" : null;
  const action = currentValue === null
    ? "create"
    : currentValue === nextValue
      ? "unchanged"
      : "update";
  return { name, currentValue, nextValue, action };
}

export function buildSetupVariablePlan(
  intent: SetupIssueIntent,
  currentVariables: Map<string, string>,
): SetupVariablePlan {
  const errors = validateIntent(intent);
  const warnings: string[] = [];
  const desired = new Map<SetupVariableName, string>();

  addDesiredVariable(desired, "AGENT_HANDLE", intent.agentHandle);
  addDesiredVariable(desired, "AGENT_ASSIGNMENT_ENABLED", intent.assignToAgent ? "true" : "false");

  if (intent.projectManagementMode === "off") {
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_ENABLED", "false");
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_DRY_RUN", "true");
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_APPLY_LABELS", "false");
  } else {
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_ENABLED", "true");
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_DRY_RUN", "true");
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_APPLY_LABELS", "false");
  }

  if (intent.projectManagementMode === "project-backed") {
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER", intent.projectOwner);
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE", intent.projectTitle);
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_PROJECT_URL", intent.projectUrl);
    addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_PROJECT_ID", intent.projectId);
    if (intent.githubProjectChoice === "create") {
      warnings.push("Project creation was requested, but `/setup apply` only stores allowlisted variables in this child.");
    }
  }

  warnings.push("GitHub Projects, Project fields/views, Project item links, and Project field sync are not changed by `/setup apply`.");

  const changes: SetupVariableChange[] = [];
  for (const [name, value] of desired) {
    const error = validateVariableValue(name, value);
    if (error) {
      errors.push(error);
      continue;
    }
    changes.push(changeFor(name, value, currentVariables));
  }

  return { changes, errors, warnings };
}

export function parseRepoVariableList(raw: string): Map<string, string> {
  const entries = JSON.parse(String(raw || "[]")) as Array<{ name?: unknown; value?: unknown }>;
  const variables = new Map<string, string>();
  for (const entry of entries) {
    const name = String(entry.name || "").trim();
    if (name) variables.set(name, String(entry.value ?? ""));
  }
  return variables;
}

export function fetchSetupIssueBody(repo: string, issueNumber: number): string {
  return gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
}

export function fetchRepoVariables(repo: string): Map<string, string> {
  return parseRepoVariableList(gh([
    "variable",
    "list",
    "--repo",
    repo,
    "--json",
    "name,value",
  ]));
}

export function applySetupVariablePlan(
  repo: string,
  changes: SetupVariableChange[],
  dryRun: boolean,
): void {
  if (dryRun) return;

  for (const change of changes) {
    if (change.action === "unchanged") continue;
    gh([
      "variable",
      "set",
      change.name,
      "--body",
      change.nextValue,
      "--repo",
      repo,
    ]);
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function valueCell(value: string | null): string {
  if (value === null) return "_unset_";
  if (!value) return "_empty_";
  const escaped = escapeCell(value);
  return escaped.length > 80 ? `\`${escaped.slice(0, 77)}...\`` : `\`${escaped}\``;
}

function resultLabel(change: SetupVariableChange, dryRun: boolean): string {
  if (change.action === "unchanged") return "unchanged";
  if (dryRun) return change.action === "create" ? "would create" : "would update";
  return change.action === "create" ? "created" : "updated";
}

export function formatSetupApplyAudit(input: {
  changes: SetupVariableChange[];
  dryRun: boolean;
  errors?: string[];
  warnings?: string[];
}): string {
  const errors = input.errors || [];
  const warnings = input.warnings || [];
  const changedCount = input.changes.filter((change) => change.action !== "unchanged").length;
  const status = errors.length > 0
    ? "Blocked"
    : input.dryRun
      ? "Dry run"
      : changedCount > 0
        ? "Applied"
        : "No changes";
  const lines = [
    SETUP_APPLY_COMMENT_MARKER,
    "## Sepo setup apply",
    "",
    `Status: **${status}**`,
    "",
  ];

  if (errors.length > 0) {
    lines.push("No repository variables were changed.", "");
    lines.push("Errors:");
    for (const error of errors) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }

  if (input.changes.length > 0) {
    lines.push("| Variable | Before | After | Result |");
    lines.push("|---|---|---|---|");
    for (const change of input.changes) {
      lines.push(
        `| \`${change.name}\` | ${valueCell(change.currentValue)} | ${valueCell(change.nextValue)} | ${resultLabel(change, input.dryRun)} |`,
      );
    }
    lines.push("");
  }

  if (errors.length === 0) {
    if (input.dryRun) {
      lines.push("Dry-run mode did not change repository variables.", "");
    } else if (changedCount === 0) {
      lines.push("All allowlisted setup variables already matched the setup issue.", "");
    }
  }

  if (warnings.length > 0) {
    lines.push("Notes:");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function findSetupApplyComment(repo: string, issueNumber: number): ExistingComment | null {
  const comments = JSON.parse(gh([
    "api",
    `repos/${repo}/issues/${issueNumber}/comments`,
  ])) as ExistingComment[];
  return comments.find((comment) => String(comment.body || "").includes(SETUP_APPLY_COMMENT_MARKER)) || null;
}

function updateIssueComment(repo: string, commentId: number, body: string): void {
  gh([
    "api",
    "-X",
    "PATCH",
    `repos/${repo}/issues/comments/${commentId}`,
    "-f",
    `body=${body}`,
  ]);
}

export function upsertSetupApplyComment(repo: string, issueNumber: number, body: string): void {
  const existing = findSetupApplyComment(repo, issueNumber);
  if (existing) {
    updateIssueComment(repo, existing.id, body);
  } else {
    postIssueComment(issueNumber, body, repo);
  }
}
