// Parses AGENT_TASK_TIMEOUT_POLICY, the repository-level configuration for
// outer GitHub Actions step timeouts on agent tasks.
//
// Shape (both sections optional):
//   {
//     "default_minutes": 30,
//     "route_overrides": {
//       "<route>": 60,
//       ...
//     }
//   }
//
// Default when empty or unset: every route gets 30 minutes.

export const DEFAULT_TASK_TIMEOUT_MINUTES = 30;
export const MAX_TASK_TIMEOUT_MINUTES = 360;

const VALID_ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

export interface TaskTimeoutPolicy {
  defaultMinutes: number;
  routeOverrides: Record<string, number>;
}

function normalizeMinutes(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  const minutes = Number(value);
  if (minutes > MAX_TASK_TIMEOUT_MINUTES) {
    throw new Error(`${label} must be at most ${MAX_TASK_TIMEOUT_MINUTES}`);
  }
  return minutes;
}

export function parseTaskTimeoutPolicy(raw: string): TaskTimeoutPolicy {
  const text = String(raw || "").trim();
  if (!text) {
    return { defaultMinutes: DEFAULT_TASK_TIMEOUT_MINUTES, routeOverrides: {} };
  }

  const payload = JSON.parse(text) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Task timeout policy must be a JSON object");
  }

  const policy: TaskTimeoutPolicy = {
    defaultMinutes: DEFAULT_TASK_TIMEOUT_MINUTES,
    routeOverrides: {},
  };

  if ("default_minutes" in payload) {
    policy.defaultMinutes = normalizeMinutes(payload.default_minutes, "default_minutes");
  }

  if ("route_overrides" in payload) {
    const overrides = payload.route_overrides;
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new Error("route_overrides must be an object");
    }
    for (const [route, minutes] of Object.entries(overrides)) {
      const normalizedRoute = String(route || "").trim().toLowerCase();
      if (!VALID_ROUTE_KEY.test(normalizedRoute)) {
        throw new Error(
          `Invalid route override key in task timeout policy: ${normalizedRoute || "missing"}`,
        );
      }
      policy.routeOverrides[normalizedRoute] = normalizeMinutes(
        minutes,
        `route_overrides.${normalizedRoute}`,
      );
    }
  }

  return policy;
}

export function getTaskTimeoutMinutesForRoute(
  policy: TaskTimeoutPolicy,
  route: string,
): number {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  if (normalizedRoute && normalizedRoute in policy.routeOverrides) {
    return policy.routeOverrides[normalizedRoute]!;
  }
  return policy.defaultMinutes;
}
