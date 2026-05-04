import { addIssueAssignee, isRepoAssigneeAssignable } from "./github.js";

export const DEFAULT_AGENT_HANDLE = "@sepo-agent";

const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export type AgentAssigneeTargetKind = "issue" | "pull_request";

export interface AgentAssigneeResolution {
  handle: string;
  login: string;
  assignable: boolean;
  warning?: string;
}

export function normalizeAgentHandle(agentHandle: string | undefined): string {
  const trimmed = (agentHandle || "").trim();
  return trimmed || DEFAULT_AGENT_HANDLE;
}

export function deriveAssigneeLogin(agentHandle: string | undefined): string {
  return normalizeAgentHandle(agentHandle).replace(/^@+/, "").trim();
}

export function validateAssigneeLogin(login: string): string | null {
  if (!login) {
    return "AGENT_HANDLE did not resolve to a GitHub login";
  }
  if (login.includes("/")) {
    return `AGENT_HANDLE resolved to ${login}, but assignment requires a user login, not a namespaced handle`;
  }
  if (!GITHUB_LOGIN_PATTERN.test(login)) {
    return `AGENT_HANDLE resolved to ${login}, which is not a valid GitHub user login`;
  }
  return null;
}

export function isAgentAssigneeTargetKind(value: string): value is AgentAssigneeTargetKind {
  return value === "issue" || value === "pull_request";
}

export function targetKindLabel(targetKind: AgentAssigneeTargetKind): string {
  return targetKind === "pull_request" ? "pull request" : "issue";
}

export function resolveAgentAssignee(input: {
  agentHandle?: string;
  repo: string;
  targetNumber: number;
  targetKind: AgentAssigneeTargetKind;
}): AgentAssigneeResolution {
  const handle = normalizeAgentHandle(input.agentHandle);
  const login = deriveAssigneeLogin(handle);
  const validationWarning = validateAssigneeLogin(login);
  if (validationWarning) {
    return { handle, login, assignable: false, warning: validationWarning };
  }
  if (!input.repo.trim()) {
    return {
      handle,
      login,
      assignable: false,
      warning: "GITHUB_REPOSITORY is required to check assignee availability",
    };
  }

  const assignable = isRepoAssigneeAssignable(login, input.repo);
  if (!assignable) {
    return {
      handle,
      login,
      assignable: false,
      warning:
        `${login} derived from AGENT_HANDLE=${handle} is not assignable in ${input.repo}, or the ` +
        "assignability check failed",
    };
  }

  return { handle, login, assignable: true };
}

export function assignAgentHandleToTarget(input: {
  agentHandle?: string;
  repo: string;
  targetKind: AgentAssigneeTargetKind;
  targetNumber: number;
}): string {
  const resolution = resolveAgentAssignee(input);
  if (!resolution.assignable) {
    return `Skipping assignment: ${resolution.warning || "assignee is not assignable"}.`;
  }

  addIssueAssignee(input.targetNumber, resolution.login, input.repo);
  return `Assigned ${targetKindLabel(input.targetKind)} #${input.targetNumber} to @${resolution.login}.`;
}
