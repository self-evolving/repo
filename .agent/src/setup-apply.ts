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
type SetupIssueChoiceField =
  | "assignToAgent"
  | "projectManagementMode"
  | "githubProjectChoice"
  | "priorityField"
  | "effortField"
  | "releaseField";

export interface SetupIssueIntent {
  errors: string[];
  invalidChoices: SetupIssueChoiceField[];
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

export type SetupVariableApplyResult =
  | "blocked"
  | "would create"
  | "would update"
  | "created"
  | "updated"
  | "unchanged"
  | "failed"
  | "not attempted";

export interface SetupVariableApplyOutcome extends SetupVariableChange {
  result: SetupVariableApplyResult;
  error?: string;
}

export interface SetupVariableApplyReport {
  results: SetupVariableApplyOutcome[];
  errors: string[];
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

function formatUnknownValue(value: string): string {
  const line = firstNonEmptyLine(value);
  return line ? `: ${line}` : ".";
}

function requiredSectionValue(
  sections: Map<string, string>,
  section: string,
  label: string,
  errors: string[],
  invalidChoices?: SetupIssueChoiceField[],
  choiceField?: SetupIssueChoiceField,
): string {
  if (!sections.has(section)) {
    errors.push(`${label} is required.`);
    if (invalidChoices && choiceField) invalidChoices.push(choiceField);
    return "";
  }
  const value = sections.get(section) || "";
  if (!firstNonEmptyLine(value)) {
    errors.push(`${label} is required.`);
    if (invalidChoices && choiceField) invalidChoices.push(choiceField);
  }
  return value;
}

function parseAssignToAgent(value: string, errors: string[], invalidChoices: SetupIssueChoiceField[]): boolean {
  const normalized = firstNonEmptyLine(value).toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("yes")) return true;
  if (normalized.startsWith("no")) return false;
  invalidChoices.push("assignToAgent");
  errors.push(`Assign accepted work to the agent has an unsupported value${formatUnknownValue(value)}`);
  return false;
}

function parseProjectManagementMode(
  value: string,
  errors: string[],
  invalidChoices: SetupIssueChoiceField[],
): ProjectManagementMode {
  const normalized = firstNonEmptyLine(value).toLowerCase();
  if (normalized === "off" || normalized === "dry-run" || normalized === "project-backed") {
    return normalized;
  }
  if (normalized) {
    invalidChoices.push("projectManagementMode");
    errors.push(`Project management mode has an unsupported value${formatUnknownValue(value)}`);
  }
  return "dry-run";
}

function parseGithubProjectChoice(
  value: string,
  errors: string[],
  invalidChoices: SetupIssueChoiceField[],
): SetupIssueIntent["githubProjectChoice"] {
  const normalized = firstNonEmptyLine(value).toLowerCase();
  if (!normalized || normalized === "do not configure a project yet" || normalized === "none") return "none";
  if (normalized === "create" || normalized === "create a new github project") return "create";
  if (normalized === "link" || normalized === "link an existing github project") return "link";
  invalidChoices.push("githubProjectChoice");
  errors.push(`GitHub Project has an unsupported value${formatUnknownValue(value)}`);
  return "none";
}

function validateRequiredChoice(
  value: string,
  label: string,
  accepted: RegExp[],
  errors: string[],
  invalidChoices: SetupIssueChoiceField[],
  choiceField: SetupIssueChoiceField,
): string {
  const line = firstNonEmptyLine(value);
  if (!line) return "";
  if (!accepted.some((pattern) => pattern.test(line))) {
    invalidChoices.push(choiceField);
    errors.push(`${label} has an unsupported value${formatUnknownValue(value)}`);
  }
  return line;
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
  const errors: string[] = [];
  const invalidChoices: SetupIssueChoiceField[] = [];
  const agentHandle = requiredSectionValue(sections, "agent handle", "Agent handle", errors);
  const assignToAgent = requiredSectionValue(
    sections,
    "assign accepted work to the agent",
    "Assign accepted work to the agent",
    errors,
    invalidChoices,
    "assignToAgent",
  );
  const projectManagementMode = requiredSectionValue(
    sections,
    "project management mode",
    "Project management mode",
    errors,
    invalidChoices,
    "projectManagementMode",
  );
  const githubProjectChoice = requiredSectionValue(
    sections,
    "github project",
    "GitHub Project",
    errors,
    invalidChoices,
    "githubProjectChoice",
  );
  const priorityField = requiredSectionValue(
    sections,
    "priority field",
    "Priority field",
    errors,
    invalidChoices,
    "priorityField",
  );
  const effortField = requiredSectionValue(
    sections,
    "effort field",
    "Effort field",
    errors,
    invalidChoices,
    "effortField",
  );
  const releaseField = requiredSectionValue(
    sections,
    "release field",
    "Release field",
    errors,
    invalidChoices,
    "releaseField",
  );
  const setupConfirmation = requiredSectionValue(sections, "setup confirmation", "Setup confirmation", errors);
  const setupNotes = sections.get("additional setup notes") || "";

  return {
    errors,
    invalidChoices,
    agentHandle: firstNonEmptyLine(agentHandle),
    assignToAgent: parseAssignToAgent(assignToAgent, errors, invalidChoices),
    projectManagementMode: parseProjectManagementMode(projectManagementMode, errors, invalidChoices),
    githubProjectChoice: parseGithubProjectChoice(githubProjectChoice, errors, invalidChoices),
    projectOwner: firstNonEmptyLine(sections.get("project owner") || ""),
    projectTitle: firstNonEmptyLine(sections.get("project title") || ""),
    projectStatuses: splitNonEmptyLines(sections.get("project status values") || ""),
    priorityField: validateRequiredChoice(priorityField, "Priority field", [
      /^create priority field with p0, p1, p2, p3$/i,
      /^use an existing priority field$/i,
      /^do not configure priority$/i,
    ], errors, invalidChoices, "priorityField"),
    effortField: validateRequiredChoice(effortField, "Effort field", [
      /^create effort field with low, medium, high$/i,
      /^use an existing effort field$/i,
      /^do not configure effort$/i,
    ], errors, invalidChoices, "effortField"),
    releaseField: validateRequiredChoice(releaseField, "Release field", [
      /^skip release for now$/i,
      /^create optional release field$/i,
      /^use an existing release field$/i,
    ], errors, invalidChoices, "releaseField"),
    releaseValues: splitNonEmptyLines(sections.get("release values") || ""),
    setupNotes,
    projectUrl: extractProjectUrl(setupNotes),
    projectId: extractProjectId(setupNotes),
    confirmationChecked: setupConfirmationsChecked(setupConfirmation),
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
  const errors: string[] = [...intent.errors];
  const invalidChoices = new Set(intent.invalidChoices);
  if (!intent.confirmationChecked) {
    errors.push("Both setup confirmation checkboxes must be checked before `/setup apply`.");
  }
  pushIfError(errors, validateAgentHandle(intent.agentHandle));
  pushIfError(errors, validateProjectOwner(intent.projectOwner));
  pushIfError(errors, validateProjectTitle(intent.projectTitle));
  pushIfError(errors, validateProjectUrl(intent.projectUrl));
  pushIfError(errors, validateProjectId(intent.projectId));

  if (intent.projectManagementMode === "project-backed" && !invalidChoices.has("projectManagementMode")) {
    if (!invalidChoices.has("githubProjectChoice") && intent.githubProjectChoice === "none") {
      errors.push("Project-backed mode requires the setup issue to create or link a GitHub Project.");
    }
    if (
      !invalidChoices.has("githubProjectChoice") &&
      !intent.projectUrl &&
      !intent.projectId &&
      (!intent.projectOwner || !intent.projectTitle)
    ) {
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
  const invalidChoices = new Set(intent.invalidChoices);
  const warnings: string[] = [];
  const desired = new Map<SetupVariableName, string>();

  addDesiredVariable(desired, "AGENT_HANDLE", intent.agentHandle);
  if (!invalidChoices.has("assignToAgent")) {
    addDesiredVariable(desired, "AGENT_ASSIGNMENT_ENABLED", intent.assignToAgent ? "true" : "false");
  }

  if (!invalidChoices.has("projectManagementMode")) {
    if (intent.projectManagementMode === "off") {
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_ENABLED", "false");
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_DRY_RUN", "true");
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_APPLY_LABELS", "false");
    } else {
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_ENABLED", "true");
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_DRY_RUN", "true");
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_APPLY_LABELS", "false");
    }

    if (intent.projectManagementMode === "project-backed" && !invalidChoices.has("githubProjectChoice")) {
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_PROJECT_OWNER", intent.projectOwner);
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_PROJECT_TITLE", intent.projectTitle);
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_PROJECT_URL", intent.projectUrl);
      addDesiredVariable(desired, "AGENT_PROJECT_MANAGEMENT_PROJECT_ID", intent.projectId);
      if (intent.githubProjectChoice === "create") {
        warnings.push("Project creation was requested, but `/setup apply` only stores allowlisted variables in this child.");
      }
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
): SetupVariableApplyReport {
  const results: SetupVariableApplyOutcome[] = [];
  const errors: string[] = [];

  if (dryRun) {
    return {
      results: changes.map((change) => ({
        ...change,
        result: change.action === "create"
          ? "would create"
          : change.action === "update"
            ? "would update"
            : "unchanged",
      })),
      errors,
    };
  }

  let failed = false;
  for (const change of changes) {
    if (failed) {
      results.push({ ...change, result: "not attempted" });
      continue;
    }
    if (change.action === "unchanged") {
      results.push({ ...change, result: "unchanged" });
      continue;
    }
    try {
      gh([
        "variable",
        "set",
        change.name,
        "--body",
        change.nextValue,
        "--repo",
        repo,
      ]);
      results.push({
        ...change,
        result: change.action === "create" ? "created" : "updated",
      });
    } catch (err: unknown) {
      const message = commandErrorText(err) || (err instanceof Error ? err.message : String(err));
      results.push({ ...change, result: "failed", error: message });
      errors.push(`Applying ${change.name} failed: ${message}`);
      failed = true;
    }
  }

  return { results, errors };
}

export function blockedSetupVariableResults(changes: SetupVariableChange[]): SetupVariableApplyOutcome[] {
  return changes.map((change) => ({ ...change, result: "blocked" }));
}

function commandErrorText(err: unknown): string {
  const record = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  const output = [record.stderr, record.stdout]
    .map((part) => {
      if (Buffer.isBuffer(part)) return part.toString("utf8");
      return typeof part === "string" ? part : "";
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  if (output) return output;
  return typeof record.message === "string" ? record.message.trim() : "";
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

function previewSetupVariableResults(
  changes: SetupVariableChange[],
  dryRun: boolean,
): SetupVariableApplyOutcome[] {
  if (dryRun) {
    return changes.map((change) => ({
      ...change,
      result: change.action === "create"
        ? "would create"
        : change.action === "update"
          ? "would update"
          : "unchanged",
    }));
  }
  return changes.map((change) => ({
    ...change,
    result: change.action === "create" ? "created" : change.action === "update" ? "updated" : "unchanged",
  }));
}

function resultLabel(outcome: SetupVariableApplyOutcome): string {
  return outcome.result;
}

export function formatSetupApplyAudit(input: {
  changes?: SetupVariableChange[];
  results?: SetupVariableApplyOutcome[];
  dryRun: boolean;
  errors?: string[];
  warnings?: string[];
}): string {
  const errors = input.errors || [];
  const warnings = input.warnings || [];
  const changes = input.changes || [];
  const results = input.results || (
    errors.length > 0
      ? blockedSetupVariableResults(changes)
      : previewSetupVariableResults(changes, input.dryRun)
  );
  const appliedCount = results.filter((result) => result.result === "created" || result.result === "updated").length;
  const plannedChangeCount = results.filter((result) => result.action !== "unchanged").length;
  const hasFailure = results.some((result) => result.result === "failed");
  const allBlocked = results.length > 0 && results.every((result) => result.result === "blocked");
  const status = hasFailure
    ? "Failed"
    : errors.length > 0
    ? "Blocked"
    : input.dryRun
      ? "Dry run"
      : appliedCount > 0
        ? "Applied"
        : "No changes";
  const lines = [
    SETUP_APPLY_COMMENT_MARKER,
    "## Sepo setup apply",
    "",
    `Status: **${status}**`,
    "",
  ];

  if (errors.length > 0 && allBlocked) {
    lines.push("No repository variables were changed.", "");
  } else if (hasFailure) {
    lines.push("Repository variable application stopped after a failure.", "");
  }

  if (errors.length > 0) {
    lines.push("Errors:");
    for (const error of errors) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }

  if (results.length > 0) {
    lines.push("| Variable | Before | After | Result |");
    lines.push("|---|---|---|---|");
    for (const result of results) {
      lines.push(
        `| \`${result.name}\` | ${valueCell(result.currentValue)} | ${valueCell(result.nextValue)} | ${resultLabel(result)} |`,
      );
    }
    lines.push("");
  }

  if (errors.length === 0) {
    if (input.dryRun) {
      lines.push("Dry-run mode did not change repository variables.", "");
    } else if (plannedChangeCount === 0) {
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
  const comments = parseIssueComments(gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/issues/${issueNumber}/comments`,
  ]));
  return comments.find((comment) => String(comment.body || "").includes(SETUP_APPLY_COMMENT_MARKER)) || null;
}

function parseIssueComments(raw: string): ExistingComment[] {
  const payload = JSON.parse(String(raw || "[]")) as unknown;
  if (!Array.isArray(payload)) return [];

  const entries = payload.every((entry) => Array.isArray(entry))
    ? payload.flat()
    : payload;
  return entries
    .filter((entry): entry is ExistingComment => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as Partial<ExistingComment>;
      return typeof record.id === "number";
    })
    .map((entry) => ({
      id: entry.id,
      body: String(entry.body || ""),
    }));
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
