import { gh } from "./github.js";
import { extractJsonObject } from "./response.js";
import { parseAccessPolicy } from "./access-policy.js";
import { normalizeAutomationMode } from "./handoff.js";
import { parseMemoryPolicy } from "./memory-policy.js";
import { parseRubricsPolicy } from "./rubrics-policy.js";
import { parseSchedulePolicy } from "./schedule-policy.js";
import { parseTaskTimeoutPolicy } from "./task-timeout-policy.js";

export type RepoConfigAction = "set" | "unset";
export type RepoConfigApplyStatus = "created" | "updated" | "deleted" | "absent" | "planned" | "failed";

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
  error?: string;
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

type RepoConfigVariableName = typeof DEFAULT_REPO_CONFIG_VARIABLES[number];
type VariableValueValidator = (value: string, name: RepoConfigVariableName) => string;

const VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_VARIABLE_VALUE_LENGTH = 48 * 1024;
const BOOLEAN_TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const BOOLEAN_FALSE_VALUES = new Set(["false", "0", "no", "off"]);
const REF_INVALID_CHARS = /[\x00-\x20~^:?*[\\]/;
const GENERIC_SINGLE_LINE_PATTERN = /^[^\r\n\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+$/;

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

function errorMessage(err: unknown): string {
  const text = commandErrorText(err).trim();
  if (text) return text;
  return err instanceof Error ? err.message : String(err);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function validateBooleanValue(value: string, name: RepoConfigVariableName): string {
  const normalized = value.trim().toLowerCase();
  if (BOOLEAN_TRUE_VALUES.has(normalized)) return "true";
  if (BOOLEAN_FALSE_VALUES.has(normalized)) return "false";
  throw new Error(`Set operation for ${name} must be a boolean value`);
}

function validateEnumValue(
  allowedValues: readonly string[],
): VariableValueValidator {
  const allowed = new Set(allowedValues);
  return (value, name) => {
    const normalized = value.trim().toLowerCase();
    if (!allowed.has(normalized)) {
      throw new Error(`Set operation for ${name} must be one of ${allowedValues.join(", ")}`);
    }
    return normalized;
  };
}

function validateAutomationModeValue(value: string, name: RepoConfigVariableName): string {
  const normalized = normalizeToken(value);
  const mode = normalizeAutomationMode(normalized);
  if (mode === "disabled" && normalized !== "disabled" && normalized !== "false") {
    throw new Error("Set operation for AGENT_AUTOMATION_MODE must be one of agent, heuristics, true, false, disabled");
  }
  if (!["agent", "heuristics", "true", "false", "disabled"].includes(normalized)) {
    throw new Error("Set operation for AGENT_AUTOMATION_MODE must be one of agent, heuristics, true, false, disabled");
  }
  return normalized;
}

function validatePositiveIntegerValue(value: string, name: RepoConfigVariableName): string {
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`Set operation for ${name} must be a positive integer`);
  }
  return normalized;
}

function validateRubricsLimitValue(value: string, name: RepoConfigVariableName): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return normalized;
  return validatePositiveIntegerValue(normalized, name);
}

function compactJson(value: string, name: RepoConfigVariableName): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch (err: unknown) {
    throw new Error(`Set operation for ${name} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function validateJsonPolicyValue(
  parser: (value: string) => unknown,
): VariableValueValidator {
  return (value, name) => {
    const compact = compactJson(value, name);
    try {
      parser(compact);
    } catch (err: unknown) {
      throw new Error(`Set operation for ${name} is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
    return compact;
  };
}

function validateRunsOnValue(value: string, name: RepoConfigVariableName): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err: unknown) {
    throw new Error(`Set operation for ${name} must be a JSON array of runner labels: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Set operation for ${name} must be a non-empty JSON array of runner labels`);
  }
  const labels = parsed.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`Set operation for ${name} runner label ${index + 1} must be a string`);
    }
    const label = entry.trim();
    if (!label || !GENERIC_SINGLE_LINE_PATTERN.test(label)) {
      throw new Error(`Set operation for ${name} runner label ${index + 1} is invalid`);
    }
    return label;
  });
  return JSON.stringify(labels);
}

function validateRefNameValue(value: string, name: RepoConfigVariableName): string {
  const ref = value.trim();
  const parts = ref.split("/");
  if (
    !ref ||
    ref.length > 255 ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref === "@" ||
    REF_INVALID_CHARS.test(ref) ||
    parts.some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error(`Set operation for ${name} must be a valid branch/ref name`);
  }
  return ref;
}

function validateMentionHandleValue(value: string, name: RepoConfigVariableName): string {
  const handle = value.trim();
  if (!/^@[^\s`<>]{1,99}$/.test(handle)) {
    throw new Error(`Set operation for ${name} must be a mention handle such as @sepo-agent`);
  }
  return handle;
}

function validateSingleLineValue(value: string, name: RepoConfigVariableName): string {
  const normalized = value.trim();
  if (!normalized || !GENERIC_SINGLE_LINE_PATTERN.test(normalized)) {
    throw new Error(`Set operation for ${name} must be a non-empty single-line value`);
  }
  return normalized;
}

function validateEmailValue(value: string, name: RepoConfigVariableName): string {
  const email = value.trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    throw new Error(`Set operation for ${name} must be an email address`);
  }
  return email;
}

const validateProviderValue = validateEnumValue(["auto", "codex", "claude"]);
const validateSessionBundleModeValue = validateEnumValue(["auto", "always", "never"]);

const VARIABLE_VALUE_VALIDATORS = {
  AGENT_ACCESS_POLICY: validateJsonPolicyValue(parseAccessPolicy),
  AGENT_ALLOW_SELF_APPROVE: validateBooleanValue,
  AGENT_ALLOW_SELF_MERGE: validateBooleanValue,
  AGENT_AUTOMATION_MAX_ROUNDS: validatePositiveIntegerValue,
  AGENT_AUTOMATION_MODE: validateAutomationModeValue,
  AGENT_AUTO_UPDATE: validateBooleanValue,
  AGENT_COLLAPSE_OLD_REVIEWS: validateBooleanValue,
  AGENT_COMMITTER_EMAIL: validateEmailValue,
  AGENT_COMMITTER_NAME: validateSingleLineValue,
  AGENT_DEFAULT_PROVIDER: validateProviderValue,
  AGENT_HANDLE: validateMentionHandleValue,
  AGENT_MEMORY_POLICY: validateJsonPolicyValue(parseMemoryPolicy),
  AGENT_MEMORY_REF: validateRefNameValue,
  AGENT_PROJECT_MANAGEMENT_APPLY_LABELS: validateBooleanValue,
  AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY: validateSingleLineValue,
  AGENT_PROJECT_MANAGEMENT_DRY_RUN: validateBooleanValue,
  AGENT_PROJECT_MANAGEMENT_ENABLED: validateBooleanValue,
  AGENT_PROJECT_MANAGEMENT_LIMIT: validatePositiveIntegerValue,
  AGENT_PROJECT_MANAGEMENT_POST_SUMMARY: validateBooleanValue,
  AGENT_RUBRICS_LIMIT: validateRubricsLimitValue,
  AGENT_RUBRICS_POLICY: validateJsonPolicyValue(parseRubricsPolicy),
  AGENT_RUBRICS_REF: validateRefNameValue,
  AGENT_RUNS_ON: validateRunsOnValue,
  AGENT_SCHEDULE_POLICY: validateJsonPolicyValue(parseSchedulePolicy),
  AGENT_SESSION_BUNDLE_MODE: validateSessionBundleModeValue,
  AGENT_STATUS_LABEL_ENABLED: validateBooleanValue,
  AGENT_TASK_TIMEOUT_POLICY: validateJsonPolicyValue(parseTaskTimeoutPolicy),
} satisfies Record<RepoConfigVariableName, VariableValueValidator>;

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
  const validator = VARIABLE_VALUE_VALIDATORS[name as RepoConfigVariableName];
  if (!validator) {
    throw new Error(`Repository variable ${name} does not have a config-route value validator`);
  }
  return validator(normalized, name as RepoConfigVariableName);
}

export class RepoConfigPartialApplyError extends Error {
  constructor(
    public readonly repo: string,
    public readonly plan: RepoConfigPlan,
    public readonly results: RepoConfigApplyResult[],
    public readonly cause?: unknown,
  ) {
    const failed = results[results.length - 1];
    super(
      failed?.status === "failed"
        ? `Failed to apply repository variable ${failed.name}: ${failed.error || "unknown error"}`
        : "Failed to apply repository variable plan",
    );
    this.name = "RepoConfigPartialApplyError";
  }
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
  const results: RepoConfigApplyResult[] = [];
  for (const operation of plan.operations) {
    try {
      results.push(applyRepoConfigOperation(repo, operation));
    } catch (err: unknown) {
      results.push({
        ...operation,
        status: "failed",
        error: errorMessage(err),
      });
      throw new RepoConfigPartialApplyError(repo, plan, results, err);
    }
  }
  return results;
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

function resultChangedState(result: RepoConfigApplyResult): boolean {
  return result.status === "created" || result.status === "updated" || result.status === "deleted";
}

function displayStatus(result: RepoConfigApplyResult | undefined): string {
  if (!result) return "planned";
  if (result.status !== "failed") return result.status;
  return result.error
    ? `failed: ${result.error.length > 96 ? `${result.error.slice(0, 93)}...` : result.error}`
    : "failed";
}

export function formatRepoConfigSummary(args: {
  repo: string;
  apply: boolean;
  plan: RepoConfigPlan;
  results?: RepoConfigApplyResult[];
  errorMessage?: string;
}): string {
  const resultsByName = new Map((args.results || []).map((result) => [result.name, result]));
  const mode = args.errorMessage ? "apply failed" : args.apply ? "applied" : "dry run";
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
    const status = displayStatus(resultsByName.get(operation.name));
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
  if (args.errorMessage) {
    const changedCount = (args.results || []).filter(resultChangedState).length;
    if (changedCount > 0) {
      lines.push(`Repository variable application failed after ${changedCount} operation(s) changed state.`);
    } else {
      lines.push("Repository variable application failed before any variables changed.");
    }
    lines.push(`Reason: ${escapeTableCell(args.errorMessage)}`);
  } else if (args.apply) {
    lines.push("Repository variable changes were applied through GitHub's Actions variables API.");
  } else {
    lines.push("Dry run only; no repository variables were changed.");
  }

  return `${lines.join("\n")}\n`;
}

export function formatRepoConfigError(
  message: string,
  details?: {
    repo: string;
    plan: RepoConfigPlan;
    results: RepoConfigApplyResult[];
  },
): string {
  if (details) {
    return formatRepoConfigSummary({
      repo: details.repo,
      apply: true,
      plan: details.plan,
      results: details.results,
      errorMessage: message,
    });
  }

  return [
    "## Repository Configuration",
    "",
    "No repository variables were changed.",
    "",
    `Reason: ${String(message || "Unknown error").trim()}`,
    "",
  ].join("\n");
}
