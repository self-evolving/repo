// Parses the structured JSON routing decision returned by the triage model
// and converts it into the portal's validated dispatch shape.

import { escapeRegex, stripNonLiveMentions } from "./mentions.js";
import { extractJsonObject } from "./response.js";
import {
  type AccessPolicy,
  getAllowedAssociationsForRoute,
  isAssociationAllowedForRoute,
} from "./access-policy.js";
import {
  LABEL_ROUTE_PREFIX,
  LABEL_SKILL_PREFIX,
  getAgentRouteDefinition,
  getDispatchRouteIds,
  getExplicitRouteCommandIds,
  getRouteForTriggerLabel,
  isRouteSupportedForTargetKind,
} from "./routes.js";

export const ROUTES = new Set(getDispatchRouteIds());

export interface DispatchDecision {
  route: string;
  needsApproval: boolean;
  confidence: string;
  summary: string;
  issueTitle: string;
  issueBody: string;
}

const EXPLICIT_ROUTE_COMMANDS = getExplicitRouteCommandIds();
const EXPLICIT_ROUTE_COMMAND_SET = new Set(EXPLICIT_ROUTE_COMMANDS);
const VALID_SKILL_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RequestedLabelDecision {
  route: string;
  skill: string;
}

export interface RequestedRouteDecision {
  route: string;
  skill: string;
}

/**
 * Extracts an explicit mention slash command such as
 * `@sepo-agent /review` from the request body.
 */
export function extractRequestedRoute(body: string, mention: string): string {
  return extractRequestedRouteDecision(body, mention).route;
}

/**
 * Extracts an explicit mention slash command decision such as
 * `@sepo-agent /review` or `@sepo-agent /skill release-notes`.
 */
export function extractRequestedRouteDecision(body: string, mention: string): RequestedRouteDecision {
  const sanitized = stripNonLiveMentions(String(body || ""));
  const trimmedMention = String(mention || "").trim();
  if (!sanitized.trim() || !trimmedMention) {
    return { route: "", skill: "" };
  }

  const routePattern = EXPLICIT_ROUTE_COMMANDS.map((route) => escapeRegex(route)).join("|");
  const explicitRegex = new RegExp(
    `(?:^|[\\s(])${escapeRegex(trimmedMention)}\\s+/(${routePattern})(?=$|[\\s.,;:!?)\\]}])`,
    "im",
  );
  const explicitMatch = sanitized.match(explicitRegex);
  if (explicitMatch) {
    return { route: explicitMatch[1].toLowerCase(), skill: "" };
  }

  const skillRegex = new RegExp(
    String.raw`(?:^|[\s(])${escapeRegex(trimmedMention)}\s+/skill\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?=$|[\s.,;:!?)\]}])`,
    "im",
  );
  const skillMatch = sanitized.match(skillRegex);
  if (!skillMatch) {
    return { route: "", skill: "" };
  }

  return {
    route: "skill",
    skill: skillMatch[1].toLowerCase(),
  };
}

/**
 * Builds a deterministic routing decision for explicit slash commands so the
 * portal can skip the dispatch agent when the user already picked the route.
 */
export function buildRequestedRouteDecision(route: string, requestText: string): DispatchDecision {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  const routeDefinition = getAgentRouteDefinition(normalizedRoute);
  if (normalizedRoute !== "skill" && !EXPLICIT_ROUTE_COMMAND_SET.has(normalizedRoute)) {
    throw new Error(`Unsupported explicit route: ${normalizedRoute || "missing"}`);
  }

  if (!routeDefinition) {
    throw new Error(`Unsupported explicit route: ${normalizedRoute || "missing"}`);
  }

  if (routeDefinition.issueTemplate) {
    return {
      route: routeDefinition.id,
      // Explicit slash commands are themselves the approval, so the portal
      // skips the approval gate. The gate still applies to triaged decisions.
      needsApproval: false,
      confidence: "high",
      summary: routeDefinition.explicitSummary || "",
      issueTitle: routeDefinition.issueTemplate.title,
      issueBody: routeDefinition.issueTemplate.body(requestText),
    };
  }

  return {
    route: routeDefinition.id,
    needsApproval: false,
    confidence: "high",
    summary: routeDefinition.explicitSummary || "",
    issueTitle: "",
    issueBody: "",
  };
}

/**
 * Resolves deterministic label-based routes. Unknown `agent/*` labels return null.
 */
export function resolveRequestedLabel(labelName: string): RequestedLabelDecision | null {
  const raw = String(labelName || "").trim();
  if (!raw) {
    return null;
  }

  const normalized = raw.toLowerCase();
  if (!normalized.startsWith(LABEL_ROUTE_PREFIX)) {
    return null;
  }

  const labelRoute = getRouteForTriggerLabel(normalized);
  if (labelRoute) {
    return { route: labelRoute.id, skill: "" };
  }
  if (normalized.startsWith(LABEL_SKILL_PREFIX)) {
    const skill = raw.slice(LABEL_SKILL_PREFIX.length).trim().toLowerCase();
    if (!skill || !VALID_SKILL_LABEL.test(skill)) {
      return null;
    }
    return { route: "skill", skill };
  }

  return null;
}

/**
 * Validates and normalizes the portal dispatch decision emitted by the model.
 */
export function normalizeDispatch(raw: string): DispatchDecision {
  const text = (raw ?? "").trim();
  if (!text) {
    throw new Error("Dispatch output was empty");
  }

  const jsonStr = extractJsonObject(text);
  if (!jsonStr) {
    throw new Error("Dispatch output did not contain a JSON object");
  }

  const payload = JSON.parse(jsonStr) as Record<string, unknown>;
  const route = String(payload.route || "").toLowerCase();
  if (!ROUTES.has(route)) {
    throw new Error(`Unsupported dispatch route: ${route || "missing"}`);
  }

  return {
    route,
    needsApproval: Boolean(payload.needs_approval),
    confidence: String(payload.confidence || "").trim().toLowerCase(),
    summary: String(payload.summary || "").trim(),
    issueTitle: String(payload.issue_title || "").trim(),
    issueBody: String(payload.issue_body || "").trim(),
  };
}

/**
 * Applies repository policy to the model-emitted dispatch decision so approval
 * requirements do not depend on the model getting control flags exactly right.
 */
export function applyDispatchPolicy(
  decision: DispatchDecision,
  targetKind: string,
  authorAssociation?: string,
  accessPolicy: AccessPolicy = { routeOverrides: {} },
  isPublicRepo = false,
  isExplicit = false,
): DispatchDecision {
  const normalized = { ...decision };
  const routeDefinition = getAgentRouteDefinition(normalized.route);

  if (
    String(authorAssociation || "").trim() &&
    !isAssociationAllowedForRoute(
      accessPolicy,
      normalized.route,
      authorAssociation || "",
      isPublicRepo,
    )
  ) {
    const allowed = getAllowedAssociationsForRoute(
      accessPolicy,
      normalized.route,
      isPublicRepo,
    );
    return {
      ...normalized,
      route: "unsupported",
      needsApproval: false,
      summary: `${normalized.route} requests currently require ${allowed.join(", ")} access.`,
      issueTitle: "",
      issueBody: "",
    };
  }

  if (routeDefinition && !isRouteSupportedForTargetKind(routeDefinition, targetKind)) {
    return {
      ...normalized,
      route: "unsupported",
      needsApproval: false,
      summary: routeDefinition.targetUnsupportedSummary || "This route is not supported for the current target.",
      issueTitle: "",
      issueBody: "",
    };
  }

  if (routeDefinition?.approval === "triaged") {
    // Triaged routes require approval as a false-positive guard; explicit
    // slash commands or labels skip the gate because the user already stated
    // the intent.
    normalized.needsApproval = !isExplicit;
    if (!normalized.issueTitle && routeDefinition.fallbackIssueTitle) {
      normalized.issueTitle = routeDefinition.fallbackIssueTitle;
    }
    if (!normalized.issueBody && routeDefinition.fallbackIssueBody) {
      normalized.issueBody = routeDefinition.fallbackIssueBody;
    }
    return normalized;
  }

  normalized.needsApproval = false;
  normalized.issueTitle = "";
  normalized.issueBody = "";
  return normalized;
}
