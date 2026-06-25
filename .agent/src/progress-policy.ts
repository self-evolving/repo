// Parses AGENT_PROGRESS_POLICY, the repository-level configuration for live
// progress comments and thumbs-down cancellation.
//
// Shape (both sections optional):
//   {
//     "default_mode": "enabled" | "report-only" | "disabled",
//     "route_overrides": {
//       "<route>": "enabled" | "report-only" | "disabled",
//       ...
//     }
//   }
//
// Default when the variable is empty or unset: implement and fix-pr get
// progress comments with cancellation; other routes are disabled.

export const PROGRESS_MODES = ["enabled", "report-only", "disabled"] as const;
export type ProgressMode = typeof PROGRESS_MODES[number];

export const DEFAULT_PROGRESS_MODE: ProgressMode = "disabled";
export const DEFAULT_PROGRESS_ROUTE_OVERRIDES: Record<string, ProgressMode> = {
  implement: "enabled",
  "fix-pr": "enabled",
  review: "disabled",
  answer: "disabled",
};

const VALID_MODE_SET: ReadonlySet<string> = new Set(PROGRESS_MODES);
const VALID_ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

export interface ProgressPolicy {
  defaultMode: ProgressMode;
  routeOverrides: Record<string, ProgressMode>;
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

export function parseProgressPolicy(raw: string): ProgressPolicy {
  const text = String(raw || "").trim();
  if (!text) {
    return {
      defaultMode: DEFAULT_PROGRESS_MODE,
      routeOverrides: { ...DEFAULT_PROGRESS_ROUTE_OVERRIDES },
    };
  }

  const payload = JSON.parse(text) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Progress policy must be a JSON object");
  }

  const policy: ProgressPolicy = {
    defaultMode: DEFAULT_PROGRESS_MODE,
    routeOverrides: { ...DEFAULT_PROGRESS_ROUTE_OVERRIDES },
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

export function progressModeAllowsComment(mode: ProgressMode): boolean {
  return mode !== "disabled";
}

export function progressModeAllowsCancel(mode: ProgressMode): boolean {
  return mode === "enabled";
}

export function isProgressMode(value: unknown): value is ProgressMode {
  return typeof value === "string" && VALID_MODE_SET.has(value);
}

export function progressTargetSupportsComments(targetKind: string): boolean {
  const normalized = String(targetKind || "").trim().toLowerCase();
  return normalized === "issue" || normalized === "pull_request" || normalized === "pr";
}
