// Parses AGENT_RUBRICS_POLICY, the repository-level configuration for which
// routes can read / write the dedicated user rubric branch.
//
// Rubrics are intentionally separate from repository memory:
// - memory captures agent/project continuity and agent-learned context
// - rubrics capture user/team preferences that steer and evaluate agent work
//
// Shape (both sections optional):
//   {
//     "default_mode": "enabled" | "read-only" | "disabled",
//     "route_overrides": {
//       "<route>": "enabled" | "read-only" | "disabled",
//       ...
//     }
//   }
//
// Default when empty or unset: every route gets "read-only". The dedicated
// rubrics update workflow opts into "enabled" with rubrics_mode_override.

export const RUBRICS_MODES = ["enabled", "read-only", "disabled"] as const;
export type RubricsMode = typeof RUBRICS_MODES[number];
export const DEFAULT_RUBRICS_MODE: RubricsMode = "read-only";
export const RUBRICS_HARD_DISABLED_ROUTES = ["dispatch"] as const;

const VALID_MODE_SET: ReadonlySet<string> = new Set(RUBRICS_MODES);
const RUBRICS_HARD_DISABLED_ROUTE_SET: ReadonlySet<string> = new Set(RUBRICS_HARD_DISABLED_ROUTES);
const VALID_ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

export interface RubricsPolicy {
  defaultMode: RubricsMode;
  routeOverrides: Record<string, RubricsMode>;
}

function normalizeMode(value: unknown, label: string): RubricsMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (!VALID_MODE_SET.has(normalized)) {
    throw new Error(
      `${label} must be one of ${RUBRICS_MODES.join(", ")} (got ${normalized || "empty"})`,
    );
  }
  return normalized as RubricsMode;
}

export function parseRubricsPolicy(raw: string): RubricsPolicy {
  const text = String(raw || "").trim();
  if (!text) {
    return { defaultMode: DEFAULT_RUBRICS_MODE, routeOverrides: {} };
  }

  const payload = JSON.parse(text) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Rubrics policy must be a JSON object");
  }

  const policy: RubricsPolicy = {
    defaultMode: DEFAULT_RUBRICS_MODE,
    routeOverrides: {},
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
          `Invalid route override key in rubrics policy: ${normalizedRoute || "missing"}`,
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

export function getRubricsModeForRoute(
  policy: RubricsPolicy,
  route: string,
): RubricsMode {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  if (isRubricsHardDisabledRoute(normalizedRoute)) {
    return "disabled";
  }
  if (normalizedRoute && normalizedRoute in policy.routeOverrides) {
    return policy.routeOverrides[normalizedRoute]!;
  }
  return policy.defaultMode;
}

export function isRubricsHardDisabledRoute(route: string): boolean {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  return RUBRICS_HARD_DISABLED_ROUTE_SET.has(normalizedRoute);
}

export function rubricsModeAllowsRead(mode: RubricsMode): boolean {
  return mode !== "disabled";
}

export function rubricsModeAllowsWrite(mode: RubricsMode): boolean {
  return mode === "enabled";
}

export function isRubricsMode(value: unknown): value is RubricsMode {
  return typeof value === "string" && VALID_MODE_SET.has(value);
}
