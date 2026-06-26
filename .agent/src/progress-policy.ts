// Parses AGENT_PROGRESS_POLICY, the repository-level configuration for live
// progress comments and thumbs-down cancellation.
//
// Shape (both sections optional):
//   {
//     "default_mode": "enabled" | "report-only" | "disabled",
//     "route_overrides": {
//       "<route>": "enabled" | "report-only" | "disabled",
//       ...
//     },
//     "orchestration_mode": "report-only" | "disabled"
//   }
//
// Default when the variable is empty or unset: implement and fix-pr get
// progress comments with cancellation; answer gets reporting without
// cancellation; other routes are disabled. Orchestrated runs default to
// disabled unless orchestration_mode opts into report-only progress.

export const PROGRESS_MODES = ["enabled", "report-only", "disabled"] as const;
export type ProgressMode = typeof PROGRESS_MODES[number];

export const DEFAULT_PROGRESS_MODE: ProgressMode = "disabled";
export const DEFAULT_ORCHESTRATION_PROGRESS_MODE: ProgressMode = "disabled";
export const DEFAULT_PROGRESS_ROUTE_OVERRIDES: Record<string, ProgressMode> = {
  implement: "enabled",
  "fix-pr": "enabled",
  review: "disabled",
  answer: "report-only",
};

const VALID_MODE_SET: ReadonlySet<string> = new Set(PROGRESS_MODES);
const VALID_ORCHESTRATION_MODE_SET: ReadonlySet<string> = new Set([
  "report-only",
  "disabled",
]);
const VALID_ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

export interface ProgressPolicy {
  defaultMode: ProgressMode;
  routeOverrides: Record<string, ProgressMode>;
  orchestrationMode: ProgressMode;
}

function normalizeMode(value: unknown, label: string): ProgressMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (!VALID_MODE_SET.has(normalized)) {
    throw new Error(
      `${label} must be one of ${PROGRESS_MODES.join(", ")} (got ${normalized || "empty"})`,
    );
  }
  return normalized as ProgressMode;
}

function normalizeOrchestrationMode(value: unknown, label: string): ProgressMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (!VALID_ORCHESTRATION_MODE_SET.has(normalized)) {
    throw new Error(
      `${label} must be one of report-only, disabled (got ${normalized || "empty"})`,
    );
  }
  return normalized as ProgressMode;
}

export function parseProgressPolicy(raw: string): ProgressPolicy {
  const text = String(raw || "").trim();
  if (!text) {
    return {
      defaultMode: DEFAULT_PROGRESS_MODE,
      routeOverrides: { ...DEFAULT_PROGRESS_ROUTE_OVERRIDES },
      orchestrationMode: DEFAULT_ORCHESTRATION_PROGRESS_MODE,
    };
  }

  const payload = JSON.parse(text) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Progress policy must be a JSON object");
  }

  const policy: ProgressPolicy = {
    defaultMode: DEFAULT_PROGRESS_MODE,
    routeOverrides: { ...DEFAULT_PROGRESS_ROUTE_OVERRIDES },
    orchestrationMode: DEFAULT_ORCHESTRATION_PROGRESS_MODE,
  };

  if ("default_mode" in payload) {
    policy.defaultMode = normalizeMode(payload.default_mode, "default_mode");
  }

  if ("route_overrides" in payload) {
    const overrides = payload.route_overrides;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new Error("route_overrides must be an object");
    }
    for (const [route, mode] of Object.entries(overrides)) {
      const normalizedRoute = String(route || "").trim().toLowerCase();
      if (!VALID_ROUTE_KEY.test(normalizedRoute)) {
        throw new Error(
          `Invalid route override key in progress policy: ${normalizedRoute || "missing"}`,
        );
      }
      policy.routeOverrides[normalizedRoute] = normalizeMode(
        mode,
        `route_overrides.${normalizedRoute}`,
      );
    }
  }

  if ("orchestration_mode" in payload) {
    policy.orchestrationMode = normalizeOrchestrationMode(
      payload.orchestration_mode,
      "orchestration_mode",
    );
  }

  return policy;
}

export function getProgressModeForRoute(
  policy: ProgressPolicy,
  route: string,
): ProgressMode {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  if (normalizedRoute && normalizedRoute in policy.routeOverrides) {
    return policy.routeOverrides[normalizedRoute]!;
  }
  return policy.defaultMode;
}

export function getProgressModeForOrchestration(policy: ProgressPolicy): ProgressMode {
  return policy.orchestrationMode;
}

export function progressModeAllowsComment(mode: ProgressMode): boolean {
  return mode !== "disabled";
}

export function progressModeAllowsCancel(mode: ProgressMode): boolean {
  return mode === "enabled";
}

export function progressResponseSupportsComments(route: string, responseKind: string): boolean {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  const normalizedResponseKind = String(responseKind || "").trim().toLowerCase();
  if (normalizedRoute !== "answer" || !normalizedResponseKind) {
    return true;
  }

  return normalizedResponseKind === "issue_comment" || normalizedResponseKind === "pr_comment";
}

export function isProgressMode(value: unknown): value is ProgressMode {
  return typeof value === "string" && VALID_MODE_SET.has(value);
}

export function progressTargetSupportsComments(targetKind: string): boolean {
  const normalized = String(targetKind || "").trim().toLowerCase();
  return normalized === "issue" || normalized === "pull_request" || normalized === "pr";
}
