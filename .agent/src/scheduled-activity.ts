import { buildAuthUrl, git } from "./git.js";
import { parseSchedulePolicy, getScheduleModeForWorkflow, type ScheduleMode } from "./schedule-policy.js";

const STATE_FILENAME = "state.json";
const REF_NOT_FOUND_PATTERN = /couldn't find remote ref|no matching remote head/i;

export interface PushOptions {
  remote?: string;
  token?: string;
  repo?: string;
}

export interface ScheduledActivityGateInput {
  eventName: string;
  schedulePolicy: string;
  workflow: string;
  activityCount?: string;
  dependencyRef?: string;
  dependencyField?: string;
  selfRef?: string;
  selfField?: string;
  cwd?: string;
  pushOptions?: PushOptions;
}

export interface ScheduledActivityGateResult {
  skip: boolean;
  mode: ScheduleMode;
  reason: string;
  dependencyValue: string;
  selfValue: string;
}

function resolveRemoteTarget(remote: string, opts?: PushOptions): string {
  if (opts?.token && opts?.repo) return buildAuthUrl(opts.token, opts.repo);
  return remote;
}

function readField(record: unknown, field: string): string {
  if (!record || typeof record !== "object" || !field) return "";
  const value = (record as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

function parseTime(value: string): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function resolveCursorActivity(
  mode: ScheduleMode,
  dependencyValue: string,
  selfValue: string,
): ScheduledActivityGateResult {
  const dependencyTime = parseTime(dependencyValue);
  const selfTime = parseTime(selfValue);

  if (dependencyTime === null || selfTime === null) {
    return {
      mode,
      skip: false,
      reason: "missing or invalid activity cursor",
      dependencyValue,
      selfValue,
    };
  }

  if (dependencyTime <= selfTime) {
    return {
      mode,
      skip: true,
      reason: "dependency cursor has not advanced",
      dependencyValue,
      selfValue,
    };
  }

  return {
    mode,
    skip: false,
    reason: "dependency cursor advanced",
    dependencyValue,
    selfValue,
  };
}

export function fetchJsonState(
  ref: string,
  cwd: string,
  opts?: PushOptions,
): Record<string, unknown> | null {
  const origin = opts?.remote ?? "origin";
  const fetchTarget = resolveRemoteTarget(origin, opts);

  try {
    git(["fetch", "--no-tags", fetchTarget, `+${ref}:${ref}`], cwd);
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString("utf8") ?? String(err);
    if (REF_NOT_FOUND_PATTERN.test(stderr)) return null;
    throw err;
  }

  try {
    const json = git(["cat-file", "blob", `${ref}:${STATE_FILENAME}`], cwd);
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function writeJsonState(
  ref: string,
  state: Record<string, unknown>,
  cwd: string,
  opts?: PushOptions,
): void {
  const origin = opts?.remote ?? "origin";
  const json = JSON.stringify(state, null, 2) + "\n";

  const blobSha = git(["hash-object", "-w", "--stdin"], cwd, json);
  const treeInput = `100644 blob ${blobSha}\t${STATE_FILENAME}\n`;
  const treeSha = git(["mktree"], cwd, treeInput);

  let parentArg: string[];
  let expectedOid: string | null = null;
  try {
    const parentSha = git(["rev-parse", "--verify", ref], cwd);
    parentArg = ["-p", parentSha];
    expectedOid = parentSha;
  } catch {
    parentArg = [];
  }

  const commitSha = git(["commit-tree", treeSha, ...parentArg, "-m", `scheduled-state: ${ref}`], cwd);
  git(["update-ref", ref, commitSha], cwd);

  const pushTarget = resolveRemoteTarget(origin, opts);
  const leaseArg = expectedOid ? `--force-with-lease=${ref}:${expectedOid}` : "--force";
  git(["push", leaseArg, pushTarget, `${ref}:${ref}`], cwd);
}

export function resolveScheduledActivityGate(
  input: ScheduledActivityGateInput,
): ScheduledActivityGateResult {
  const policy = parseSchedulePolicy(input.schedulePolicy);
  const mode = getScheduleModeForWorkflow(policy, input.workflow);

  const base = {
    mode,
    dependencyValue: "",
    selfValue: "",
  };

  if (input.eventName !== "schedule") {
    return { ...base, skip: false, reason: "non-scheduled run" };
  }
  if (mode === "disabled") {
    return { ...base, skip: true, reason: "schedule policy disabled workflow" };
  }
  if (mode === "always_run") {
    return { ...base, skip: false, reason: "schedule policy always_run" };
  }

  const dependencyRef = input.dependencyRef || "";
  const dependencyField = input.dependencyField || "";
  const selfRef = input.selfRef || "";
  const selfField = input.selfField || "";
  const activityCount = input.activityCount ?? "";
  if (activityCount.trim()) {
    const count = Number(activityCount);
    if (Number.isFinite(count) && count <= 0) {
      return { ...base, skip: true, reason: "activity count is zero" };
    }
    if (Number.isFinite(count) && count > 0) {
      return { ...base, skip: false, reason: "activity count is nonzero" };
    }
    return { ...base, skip: false, reason: "invalid activity count" };
  }
  if (!dependencyRef || !dependencyField || !selfRef || !selfField) {
    return { ...base, skip: false, reason: "missing activity cursor configuration" };
  }

  const cwd = input.cwd || process.cwd();
  const dependencyValue = readField(
    fetchJsonState(dependencyRef, cwd, input.pushOptions),
    dependencyField,
  );
  const selfValue = readField(fetchJsonState(selfRef, cwd, input.pushOptions), selfField);
  return resolveCursorActivity(mode, dependencyValue, selfValue);
}
