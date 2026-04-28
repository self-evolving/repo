const VALID_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
]);

const VALID_ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

const DEFAULT_PRIVATE_ALLOWED_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
] as const;

const DEFAULT_PUBLIC_ALLOWED_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
] as const;

export interface AccessPolicy {
  defaultAllowedAssociations?: readonly string[];
  routeOverrides: Record<string, readonly string[]>;
}

function normalizeAssociationList(
  value: unknown,
  label: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  const normalized = value.map((entry) => String(entry || "").trim().toUpperCase());
  if (normalized.length === 0) {
    throw new Error(`${label} must contain at least one author association`);
  }

  if (normalized.some((entry) => !VALID_ASSOCIATIONS.has(entry))) {
    throw new Error(`${label} contains unsupported author associations`);
  }

  return [...new Set(normalized)];
}

export function isKnownAuthorAssociation(association: string): boolean {
  return VALID_ASSOCIATIONS.has(String(association || "").trim().toUpperCase());
}

export function parseAccessPolicy(raw: string): AccessPolicy {
  const text = String(raw || "").trim();
  if (!text) {
    return { routeOverrides: {} };
  }

  const payload = JSON.parse(text) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Access policy must be a JSON object");
  }

  const policy: AccessPolicy = { routeOverrides: {} };

  if ("allowed_associations" in payload) {
    policy.defaultAllowedAssociations = normalizeAssociationList(
      payload.allowed_associations,
      "allowed_associations",
    );
  }

  if ("route_overrides" in payload) {
    const routePolicy = payload.route_overrides;
    if (!routePolicy || typeof routePolicy !== "object" || Array.isArray(routePolicy)) {
      throw new Error("route_overrides must be an object");
    }

    for (const [route, associations] of Object.entries(routePolicy)) {
      const normalizedRoute = String(route || "").trim().toLowerCase();
      if (!VALID_ROUTE_KEY.test(normalizedRoute)) {
        throw new Error(`Invalid route override key in access policy: ${normalizedRoute || "missing"}`);
      }
      policy.routeOverrides[normalizedRoute] = normalizeAssociationList(
        associations,
        `route_overrides.${normalizedRoute}`,
      );
    }
  }

  return policy;
}

export function getAllowedAssociationsForRoute(
  policy: AccessPolicy,
  route: string,
  isPublicRepo: boolean,
): string[] {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  const configuredRoute = normalizedRoute
    ? policy.routeOverrides[normalizedRoute]
    : undefined;
  if (configuredRoute) {
    return [...configuredRoute];
  }

  if (policy.defaultAllowedAssociations) {
    return [...policy.defaultAllowedAssociations];
  }

  return isPublicRepo
    ? [...DEFAULT_PUBLIC_ALLOWED_ASSOCIATIONS]
    : [...DEFAULT_PRIVATE_ALLOWED_ASSOCIATIONS];
}

export function isAssociationAllowedForRoute(
  policy: AccessPolicy,
  route: string,
  association: string,
  isPublicRepo: boolean,
): boolean {
  const normalizedAssociation = String(association || "").trim().toUpperCase();
  return getAllowedAssociationsForRoute(policy, route, isPublicRepo).includes(
    normalizedAssociation,
  );
}
