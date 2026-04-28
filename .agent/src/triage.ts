// Parses the structured JSON routing decision returned by the triage model
// and converts it into the portal's validated dispatch shape.

import { escapeRegex, stripNonLiveMentions } from "./mentions.js";
import { extractJsonObject } from "./response.js";
import {
  type AccessPolicy,
  getAllowedAssociationsForRoute,
  isAssociationAllowedForRoute,
} from "./access-policy.js";

export const ROUTES = new Set([
  "answer",
  "implement",
  "fix-pr",
  "review",
  "create-action",
  "unsupported",
]);

export interface DispatchDecision {
  route: string;
  needsApproval: boolean;
  confidence: string;
  summary: string;
  issueTitle: string;
  issueBody: string;
}

const EXPLICIT_ROUTE_COMMANDS = ["answer", "implement", "fix-pr", "review", "create-action"] as const;
const LABEL_ROUTE_PREFIX = "agent/";
const LABEL_SKILL_PREFIX = "agent/s/";
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
  if (
    normalizedRoute !== "skill" &&
    !EXPLICIT_ROUTE_COMMANDS.includes(normalizedRoute as (typeof EXPLICIT_ROUTE_COMMANDS)[number])
  ) {
    throw new Error(`Unsupported explicit route: ${normalizedRoute || "missing"}`);
  }

  if (normalizedRoute === "implement") {
    const originalRequest = String(requestText || "").trim() || "No request text provided.";
    return {
      route: "implement",
      // Explicit /implement is itself the approval, so the portal skips the
      // approval gate and dispatches agent-implement directly. The gate still
      // applies to triaged implement decisions (see applyDispatchPolicy).
      needsApproval: false,
      confidence: "high",
      summary: "I’ll start implementing this request.",
      issueTitle: "Implement requested change",
      issueBody: [
        "## Goal",
        "Implement the requested change from the agent mention.",
        "",
        "## Original request",
        originalRequest,
        "",
        "## Acceptance criteria",
        "- Implement the requested change.",
        "- Preserve existing behavior unless the request requires a change.",
        "- Update tests or validation as needed.",
      ].join("\n"),
    };
  }

  if (normalizedRoute === "create-action") {
    const originalRequest = String(requestText || "").trim() || "No request text provided.";
    return {
      route: "create-action",
      needsApproval: false,
      confidence: "high",
      summary: "I’ll create a pull request for a scheduled agent workflow.",
      issueTitle: "Create scheduled agent workflow",
      issueBody: [
        "## Goal",
        "Create a scheduled GitHub Actions workflow from the agent mention.",
        "",
        "## Original request",
        originalRequest,
        "",
        "## Acceptance criteria",
        "- Add or update one standalone workflow under `.github/workflows/`.",
        "- Use native GitHub Actions triggers for schedule/manual runs.",
        "- Include an expiration guard before running the agent task.",
        "- Preserve activation through normal PR review and merge.",
      ].join("\n"),
    };
  }

  if (normalizedRoute === "fix-pr") {
    return {
      route: "fix-pr",
      needsApproval: false,
      confidence: "high",
      summary: "I’ll start a PR fix pass.",
      issueTitle: "",
      issueBody: "",
    };
  }

  if (normalizedRoute === "review") {
    return {
      route: "review",
      needsApproval: false,
      confidence: "high",
      summary: "I’ll start a review pass.",
      issueTitle: "",
      issueBody: "",
    };
  }

  if (normalizedRoute === "skill") {
    return {
      route: "skill",
      needsApproval: false,
      confidence: "high",
      summary: "I’ll run the requested skill.",
      issueTitle: "",
      issueBody: "",
    };
  }

  return {
    route: "answer",
    needsApproval: false,
    confidence: "high",
    summary: "I’ll answer inline.",
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

  if (normalized === "agent/answer") {
    return { route: "answer", skill: "" };
  }
  if (normalized === "agent/implement") {
    return { route: "implement", skill: "" };
  }
  if (normalized === "agent/fix-pr") {
    return { route: "fix-pr", skill: "" };
  }
  if (normalized === "agent/review") {
    return { route: "review", skill: "" };
  }
  if (normalized === "agent/create-action") {
    return { route: "create-action", skill: "" };
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

  if (normalized.route === "implement") {
    // Triaged implement always requires approval as a false-positive guard;
    // explicit /implement (slash command or agent/implement label) skips the
    // gate because the user already stated the intent.
    normalized.needsApproval = !isExplicit;
    return normalized;
  }

  if (normalized.route === "create-action") {
    normalized.needsApproval = !isExplicit;
    if (!normalized.issueTitle) {
      normalized.issueTitle = "Create scheduled agent workflow";
    }
    if (!normalized.issueBody) {
      normalized.issueBody = "Create a scheduled GitHub Actions workflow for the requested automation.";
    }
    return normalized;
  }

  if (normalized.route === "fix-pr") {
    if (targetKind !== "pull_request") {
      return {
        ...normalized,
        route: "unsupported",
        needsApproval: false,
        summary:
          "PR fix requests are only supported from pull requests right now.",
        issueTitle: "",
        issueBody: "",
      };
    }

    normalized.needsApproval = false;
    normalized.issueTitle = "";
    normalized.issueBody = "";
    return normalized;
  }

  if (normalized.route === "review") {
    if (targetKind !== "pull_request") {
      return {
        ...normalized,
        route: "unsupported",
        needsApproval: false,
        summary:
          "Review requests are only supported from pull requests right now.",
        issueTitle: "",
        issueBody: "",
      };
    }

    normalized.needsApproval = false;
    normalized.issueTitle = "";
    normalized.issueBody = "";
    return normalized;
  }

  if (normalized.route === "skill") {
    normalized.needsApproval = false;
    normalized.issueTitle = "";
    normalized.issueBody = "";
    return normalized;
  }

  normalized.needsApproval = false;
  normalized.issueTitle = "";
  normalized.issueBody = "";
  return normalized;
}
