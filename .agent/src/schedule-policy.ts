// Parses AGENT_SCHEDULE_POLICY, the repository-level configuration for
// scheduled workflow runs.
//
// Shape (both sections optional):
//   {
//     "default_mode": "always_run" | "skip_no_updates" | "disabled",
//     "workflow_overrides": {
//       "<workflow filename>": "always_run" | "skip_no_updates" | "disabled",
//       ...
//     }
//   }

export const SCHEDULE_MODES = ["always_run", "skip_no_updates", "disabled"] as const;
export type ScheduleMode = typeof SCHEDULE_MODES[number];
export const DEFAULT_SCHEDULE_MODE: ScheduleMode = "skip_no_updates";
export const DEFAULT_SCHEDULE_WORKFLOW_OVERRIDES: Record<string, ScheduleMode> = {
  "agent-memory-sync.yml": "always_run",
};

const VALID_MODE_SET: ReadonlySet<string> = new Set(SCHEDULE_MODES);
const VALID_WORKFLOW_KEY = /^[a-z0-9][a-z0-9._-]*\.ya?ml$/;

export interface SchedulePolicy {
  defaultMode: ScheduleMode;
  workflowOverrides: Record<string, ScheduleMode>;
}

function normalizeMode(value: unknown, label: string): ScheduleMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (!VALID_MODE_SET.has(normalized)) {
    throw new Error(
      `${label} must be one of ${SCHEDULE_MODES.join(", ")} (got ${normalized || "empty"})`,
    );
  }
  return normalized as ScheduleMode;
}

function normalizeWorkflow(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export function parseSchedulePolicy(raw: string): SchedulePolicy {
  const text = String(raw || "").trim();
  if (!text) {
    return {
      defaultMode: DEFAULT_SCHEDULE_MODE,
      workflowOverrides: { ...DEFAULT_SCHEDULE_WORKFLOW_OVERRIDES },
    };
  }

  const payload = JSON.parse(text) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Schedule policy must be a JSON object");
  }

  const policy: SchedulePolicy = {
    defaultMode: DEFAULT_SCHEDULE_MODE,
    workflowOverrides: {},
  };

  if ("default_mode" in payload) {
    policy.defaultMode = normalizeMode(payload.default_mode, "default_mode");
  }

  if ("workflow_overrides" in payload) {
    const overrides = payload.workflow_overrides;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new Error("workflow_overrides must be an object");
    }
    for (const [workflow, mode] of Object.entries(overrides)) {
      const normalizedWorkflow = normalizeWorkflow(workflow);
      if (!VALID_WORKFLOW_KEY.test(normalizedWorkflow)) {
        throw new Error(
          `Invalid workflow override key in schedule policy: ${normalizedWorkflow || "missing"}`,
        );
      }
      policy.workflowOverrides[normalizedWorkflow] = normalizeMode(
        mode,
        `workflow_overrides.${normalizedWorkflow}`,
      );
    }
  }

  return policy;
}

export function getScheduleModeForWorkflow(
  policy: SchedulePolicy,
  workflow: string,
): ScheduleMode {
  const normalizedWorkflow = normalizeWorkflow(workflow);
  if (normalizedWorkflow && normalizedWorkflow in policy.workflowOverrides) {
    return policy.workflowOverrides[normalizedWorkflow]!;
  }
  return policy.defaultMode;
}

export function isScheduleMode(value: unknown): value is ScheduleMode {
  return typeof value === "string" && VALID_MODE_SET.has(value);
}
