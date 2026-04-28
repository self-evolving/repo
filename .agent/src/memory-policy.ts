// Parses AGENT_MEMORY_POLICY, the repository-level configuration for which
// routes can read / write agent memory.
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
// Default when the variable is empty or unset: every route gets "enabled".
// Modes:
//   - enabled    — download memory before the run; commit+push edits after
//   - read-only  — download memory before the run; skip the commit step
//   - disabled   — skip memory entirely

export const MEMORY_MODES = ["enabled", "read-only", "disabled"] as const;
export type MemoryMode = typeof MEMORY_MODES[number];
export const DEFAULT_MEMORY_MODE: MemoryMode = "enabled";

const VALID_MODE_SET: ReadonlySet<string> = new Set(MEMORY_MODES);
const VALID_ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

export interface MemoryPolicy {
  defaultMode: MemoryMode;
  routeOverrides: Record<string, MemoryMode>;
}

function normalizeMode(value: unknown, label: string): MemoryMode {
  const normalized = String(value || "").trim().toLowerCase();
  if (!VALID_MODE_SET.has(normalized)) {
    throw new Error(
      `${label} must be one of ${MEMORY_MODES.join(", ")} (got ${normalized || "empty"})`,
    );
  }
  return normalized as MemoryMode;
}

export function parseMemoryPolicy(raw: string): MemoryPolicy {
  const text = String(raw || "").trim();
  if (!text) {
    return { defaultMode: DEFAULT_MEMORY_MODE, routeOverrides: {} };
  }

  const payload = JSON.parse(text) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Memory policy must be a JSON object");
  }

  const policy: MemoryPolicy = {
    defaultMode: DEFAULT_MEMORY_MODE,
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
          `Invalid route override key in memory policy: ${normalizedRoute || "missing"}`,
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

export function getMemoryModeForRoute(
  policy: MemoryPolicy,
  route: string,
): MemoryMode {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  if (normalizedRoute && normalizedRoute in policy.routeOverrides) {
    return policy.routeOverrides[normalizedRoute]!;
  }
  return policy.defaultMode;
}

export function memoryModeAllowsRead(mode: MemoryMode): boolean {
  return mode !== "disabled";
}

export function memoryModeAllowsWrite(mode: MemoryMode): boolean {
  return mode === "enabled";
}

export function isMemoryMode(value: unknown): value is MemoryMode {
  return typeof value === "string" && VALID_MODE_SET.has(value);
}
