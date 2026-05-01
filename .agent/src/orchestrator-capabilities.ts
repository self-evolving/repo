import {
  getAllowedAssociationsForRoute,
  isAssociationAllowedForRoute,
  isKnownAuthorAssociation,
  parseAccessPolicy,
} from "./access-policy.js";

export const ORCHESTRATE_DELEGATED_ROUTES = ["implement", "review", "fix-pr"] as const;

export interface InitialOrchestrateCapabilityInput {
  sourceAction: string;
  sourceConclusion: string;
  currentRound: number;
  authorAssociation: string;
  accessPolicy: string;
  isPublicRepo: boolean;
}

function normalizeToken(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function initialOrchestrateCapabilityStopReason(input: InitialOrchestrateCapabilityInput): string {
  if (
    normalizeToken(input.sourceAction) !== "orchestrate" ||
    normalizeToken(input.sourceConclusion) !== "requested" ||
    input.currentRound !== 1
  ) {
    return "";
  }

  let policy;
  try {
    policy = parseAccessPolicy(input.accessPolicy);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `invalid AGENT_ACCESS_POLICY: ${msg}`;
  }

  const association = isKnownAuthorAssociation(input.authorAssociation) ? input.authorAssociation : "NONE";
  for (const route of ORCHESTRATE_DELEGATED_ROUTES) {
    if (isAssociationAllowedForRoute(policy, route, association, input.isPublicRepo)) {
      continue;
    }
    const allowed = getAllowedAssociationsForRoute(policy, route, input.isPublicRepo);
    return `orchestrate requests require ${route} access; ${route} currently requires ${allowed.join(", ")} access.`;
  }

  return "";
}
