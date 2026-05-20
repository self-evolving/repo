import { gh } from "./github.js";
import { extractJsonObject } from "./response.js";

export type RepoConfigAction = "set" | "unset";
export type RepoConfigApplyStatus = "created" | "updated" | "deleted" | "absent" | "planned";

export interface RepoConfigOperation {
  action: RepoConfigAction;
  name: string;
  value?: string;
  reason: string;
}

export interface RepoConfigPlan {
  operations: RepoConfigOperation[];
}

export interface RepoConfigApplyResult extends RepoConfigOperation {
  status: RepoConfigApplyStatus;
}

export const DEFAULT_REPO_CONFIG_VARIABLES = [
  "AGENT_ACCESS_POLICY",
  "AGENT_ALLOW_SELF_APPROVE",
  "AGENT_ALLOW_SELF_MERGE",
  "AGENT_AUTOMATION_MAX_ROUNDS",
  "AGENT_AUTOMATION_MODE",
  "AGENT_AUTO_UPDATE",
  "AGENT_COLLAPSE_OLD_REVIEWS",
  "AGENT_COMMITTER_EMAIL",
  "AGENT_COMMITTER_NAME",
  "AGENT_DEFAULT_PROVIDER",
  "AGENT_HANDLE",
  "AGENT_MEMORY_POLICY",
  "AGENT_MEMORY_REF",
  "AGENT_PROJECT_MANAGEMENT_APPLY_LABELS",
  "AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY",
  "AGENT_PROJECT_MANAGEMENT_DRY_RUN",
  "AGENT_PROJECT_MANAGEMENT_ENABLED",
  "AGENT_PROJECT_MANAGEMENT_LIMIT",
  "AGENT_PROJECT_MANAGEMENT_POST_SUMMARY",
  "AGENT_RUBRICS_LIMIT",
  "AGENT_RUBRICS_POLICY",
  "AGENT_RUBRICS_REF",
  "AGENT_RUNS_ON",
  "AGENT_SCHEDULE_POLICY",
  "AGENT_SESSION_BUNDLE_MODE",
  "AGENT_STATUS_LABEL_ENABLED",
  "AGENT_TASK_TIMEOUT_POLICY",
] as const;

const VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_VARIABLE_VALUE_LENGTH = 48 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function commandErrorText(err: unknown): string {
  const record = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [record.message, record.stderr, record.stdout]
    .map((part) => {
      if (Buffer.isBuffer(part)) return part.toString("utf8");
      return typeof part === "string" ? part : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isNotFoundError(err: unknown): boolean {
  return /HTTP 404|not found/i.test(commandErrorText(err));
}

function isAlreadyExistsError(err: unknown): boolean {
  return /HTTP 409|already exists|already_exists|name has already been taken/i.test(commandErrorText(err));
}

function normalizeAction(value: unknown): RepoConfigAction {
  const action = String(value || "").trim().toLowerCase();
  if (action !== "set" && action !== "unset") {
    throw new Error(`Unsupported repo config action: ${action || "missing"}`);
  }
  return action;
}

function normalizeVariableName(value: unknown, allowedVariables: Set<string>): string {
  const name = String(value || "").trim().toUpperCase();
  if (!VARIABLE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid repository variable name: ${name || "missing"}`);
  }
  if (!allowedVariables.has(name)) {
    throw new Error(`Repository variable ${name} is not allowed for the config route`);
  }
  return name;
}

function normalizeVariableValue(value: unknown, name: string): string {
  if (value === undefined || value === null) {
    throw new Error(`Set operation for ${name} must include value`);
  }

  let normalized = "";
  if (typeof value === "string") {
    normalized = value.trim();
  } else if (typeof value === "boolean") {
    normalized = value ? "true" : "false";
  } else if (typeof value === "number" && Number.isFinite(value)) {
    normalized = String(value);
  } else {
    throw new Error(`Set operation for ${name} must use a string, boolean, or number value`);
  }

  if (!normalized) {
    throw new Error(`Set operation for ${name} must not use an empty value`);
  }
  if (normalized.includes("\0")) {
    throw new Error(`Set operation for ${name} contains an invalid NUL character`);
  }
  if (normalized.length > MAX_VARIABLE_VALUE_LENGTH) {
    throw new Error(`Set operation for ${name} exceeds ${MAX_VARIABLE_VALUE_LENGTH} characters`);
  }
  return normalized;
}

export function parseRepoConfigPlan(
  markdown: string,
  allowedVariableNames: readonly string[] = DEFAULT_REPO_CONFIG_VARIABLES,
): RepoConfigPlan {
  const jsonStr = extractJsonObject(markdown);
  if (!jsonStr) {
    throw new Error("Repo config response did not contain a JSON object");
  }

  const payload = JSON.parse(jsonStr) as unknown;
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.operations)) {
    throw new Error("Repo config response must include an operations array");
  }
  if (root.operations.length === 0) {
    const reason = String(root.reason || "").trim();
    throw new Error(
      reason
        ? `Repo config response did not include operations: ${reason}`
        : "Repo config response must include at least one operation",
    );
  }

  const allowedVariables = new Set(allowedVariableNames.map((name) => String(name).trim().toUpperCase()));
  const seenNames = new Set<string>();
  const operations: RepoConfigOperation[] = [];

  for (const [index, rawOperation] of root.operations.entries()) {
    const operation = asRecord(rawOperation);
    if (!operation) {
      throw new Error(`Repo config operation ${index + 1} must be an object`);
    }

    const action = normalizeAction(operation.action);
    const name = normalizeVariableName(operation.name, allowedVariables);
    if (seenNames.has(name)) {
      throw new Error(`Repo config response contains multiple operations for ${name}`);
    }
    seenNames.add(name);

    const reason = String(operation.reason || "").trim() || "No reason provided.";
    if (action === "unset") {
      if (
        Object.prototype.hasOwnProperty.call(operation, "value") &&
        String(operation.value || "").trim()
      ) {
        throw new Error(`Unset operation for ${name} must not include value`);
      }
      operations.push({ action, name, reason });
      continue;
    }

    operations.push({
      action,
      name,
      value: normalizeVariableValue(operation.value, name),
      reason,
    });
  }

  return { operations };
}

export function countRepoConfigOperations(plan: RepoConfigPlan): number {
  return plan.operations.length;
}

function repositoryVariableEndpoint(repo: string, name: string): string {
  return `repos/${repo}/actions/variables/${encodeURIComponent(name)}`;
}

export function repositoryVariableExists(repo: string, name: string): boolean {
  try {
    gh(["api", repositoryVariableEndpoint(repo, name)]);
    return true;
  } catch (err: unknown) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

export function createRepositoryVariable(repo: string, name: string, value: string): void {
  gh([
    "api",
    "-X",
    "POST",
    `repos/${repo}/actions/variables`,
    "-f",
    `name=${name}`,
    "-f",
    `value=${value}`,
  ]);
}

export function updateRepositoryVariable(repo: string, name: string, value: string): void {
  gh([
    "api",
    "-X",
    "PATCH",
    repositoryVariableEndpoint(repo, name),
    "-f",
    `name=${name}`,
    "-f",
    `value=${value}`,
  ]);
}

export function deleteRepositoryVariable(repo: string, name: string): void {
  gh(["api", "-X", "DELETE", repositoryVariableEndpoint(repo, name)]);
}

export function applyRepoConfigOperation(
  repo: string,
  operation: RepoConfigOperation,
): RepoConfigApplyResult {
  if (operation.action === "unset") {
    if (!repositoryVariableExists(repo, operation.name)) {
      return { ...operation, status: "absent" };
    }
    deleteRepositoryVariable(repo, operation.name);
    return { ...operation, status: "deleted" };
  }

  const value = operation.value ?? "";
  if (repositoryVariableExists(repo, operation.name)) {
    try {
      updateRepositoryVariable(repo, operation.name, value);
      return { ...operation, status: "updated" };
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err;
      createRepositoryVariable(repo, operation.name, value);
      return { ...operation, status: "created" };
    }
  }

  try {
    createRepositoryVariable(repo, operation.name, value);
    return { ...operation, status: "created" };
  } catch (err: unknown) {
    if (!isAlreadyExistsError(err)) throw err;
    updateRepositoryVariable(repo, operation.name, value);
    return { ...operation, status: "updated" };
  }
}

export function applyRepoConfigPlan(repo: string, plan: RepoConfigPlan): RepoConfigApplyResult[] {
  return plan.operations.map((operation) => applyRepoConfigOperation(repo, operation));
}

function escapeTableCell(value: string): string {
  return String(value || "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function displayValue(operation: RepoConfigOperation): string {
  if (operation.action === "unset") {
    return "n/a";
  }
  const value = operation.value || "";
  return value.length > 96 ? `${value.slice(0, 93)}...` : value;
}

export function formatRepoConfigSummary(args: {
  repo: string;
  apply: boolean;
  plan: RepoConfigPlan;
  results?: RepoConfigApplyResult[];
}): string {
  const resultsByName = new Map((args.results || []).map((result) => [result.name, result]));
  const mode = args.apply ? "applied" : "dry run";
  const lines = [
    "## Repository Configuration",
    "",
    `- Repository: \`${args.repo}\``,
    `- Mode: \`${mode}\``,
    `- Operations: ${args.plan.operations.length}`,
    "",
    "| Action | Variable | Value | Status | Reason |",
    "|---|---|---|---|---|",
  ];

  for (const operation of args.plan.operations) {
    const status = resultsByName.get(operation.name)?.status || "planned";
    lines.push(
      `| ${[
        operation.action,
        `\`${operation.name}\``,
        `\`${escapeTableCell(displayValue(operation))}\``,
        status,
        escapeTableCell(operation.reason),
      ].join(" | ")} |`,
    );
  }

  lines.push("");
  if (args.apply) {
    lines.push("Repository variable changes were applied through GitHub's Actions variables API.");
  } else {
    lines.push("Dry run only; no repository variables were changed.");
  }

  return `${lines.join("\n")}\n`;
}

export function formatRepoConfigError(message: string): string {
  return [
    "## Repository Configuration",
    "",
    "No repository variables were changed.",
    "",
    `Reason: ${String(message || "Unknown error").trim()}`,
    "",
  ].join("\n");
}
