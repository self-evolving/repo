import {
  getAllowedAssociationsForRoute,
  isAssociationAllowedForRoute,
  isKnownAuthorAssociation,
  parseAccessPolicy,
} from "./access-policy.js";

/**
 * Concrete routes that an initial `/orchestrate` request may launch directly or
 * through issue-level delegation.
 */
export const ORCHESTRATE_DELEGATED_ROUTES = ["implement", "review", "fix-pr"] as const;
export const ORCHESTRATE_SELF_APPROVE_ROUTE = "agent-self-approve" as const;

/**
 * Requester and policy context needed to decide whether an initial
 * `/orchestrate` start can use the full delegated route capability set.
 */
export interface InitialOrchestrateCapabilityInput {
  sourceAction: string;
  sourceConclusion: string;
  currentRound: number;
  authorAssociation: string;
  accessPolicy: string;
  isPublicRepo: boolean;
  selfApproveEnabled?: boolean;
}

function normalizeToken(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Returns a user-visible stop reason when an initial `/orchestrate` request
 * lacks delegated route capability. Returns an empty string when the check does
 * not apply or the requester is authorized.
 */
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
  const delegatedRoutes: string[] = [...ORCHESTRATE_DELEGATED_ROUTES];
  if (input.selfApproveEnabled) {
    delegatedRoutes.push(ORCHESTRATE_SELF_APPROVE_ROUTE);
  }

  for (const route of delegatedRoutes) {
    if (isAssociationAllowedForRoute(policy, route, association, input.isPublicRepo)) {
      continue;
    }
    const allowed = getAllowedAssociationsForRoute(policy, route, input.isPublicRepo);
    return `orchestrate requests require ${route} access; ${route} currently requires ${allowed.join(", ")} access.`;
  }

  return "";
}
