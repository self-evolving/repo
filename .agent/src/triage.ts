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
  "orchestrate",
  "create-action",
  "add-rubrics",
  "unsupported",
]);

export interface DispatchDecision {
  route: string;
  needsApproval: boolean;
  confidence: string;
  summary: string;
  issueTitle: string;
  issueBody: string;
  basePr?: string;
}

export type TriageMode = "commands" | "agent";

const EXPLICIT_ROUTE_COMMANDS = [
  "answer",
  "implement",
  "fix-pr",
  "review",
  "orchestrate",
  "create-action",
  "add-rubrics",
  "install",
] as const;
const LABEL_ROUTE_PREFIX = "agent/";
const LABEL_SKILL_PREFIX = "agent/s/";
const VALID_SKILL_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const INSTALL_ROUTE = "install";
const DEFAULT_IMPLEMENT_ISSUE_TITLE = "Implement requested change";
const MAX_IMPLEMENT_ISSUE_TITLE_LENGTH = 70;
const DEFAULT_ADD_RUBRICS_ISSUE_TITLE = "Propose rubric updates";
const IMPERATIVE_ANCESTRY_REQUEST = String.raw`(?:^|[.;:!?\n]|\b(?:and|but|then)\b)\s*(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+|let['’]s\s+)?(?:create|make|open|start|build|land|implement|continue|recreate|do|use|add)`;
const STACKED_IMPLEMENT_REQUEST = new RegExp(
  [
    String.raw`\bstack(?:ed|ing)?\s+(?:this|it)(?:\s+(?:change|work|implementation|pr|pull request))?(?:\s+(?:on|onto|above)\b)?`,
    String.raw`\bstack(?:ed|ing)?\s+the\s+(?:change|work|implementation|pr|pull request)\b`,
    String.raw`\bstack(?:ed|ing)?\s+(?:on|onto|above)\s+(?:this|the|current|source|open)\s+(?:pr|pull request|branch|change|work|implementation)\b`,
    String.raw`${IMPERATIVE_ANCESTRY_REQUEST}\s+(?:(?:this|it|the\s+(?:change|work|implementation))\s+(?:(?:as|in)\s+)?(?:an?\s+)?|an?\s+)?stacked\s+(?:(?:follow[\s-]?up)\s+)?(?:pr|pull request|branch|change|work|implementation)\b`,
    String.raw`${IMPERATIVE_ANCESTRY_REQUEST}\s+(?:(?:this|it|the\s+(?:change|work|implementation))\s+(?:(?:as|in)\s+)?(?:an?\s+)?|an?\s+)?follow[\s-]?up\s+(?:pr|pull request|branch|change|work|implementation)\b`,
    String.raw`\bfollow[\s-]?up\s+(?:on|to|from)\s+(?:(?:this|the|current|source|open)\s+){1,2}(?:pr|pull request|branch|change|work|implementation)\b`,
    String.raw`\bon top of (?:this|the|current) (?:pr|pull request|branch)\b`,
  ].join("|"),
  "i",
);
const INDEPENDENT_IMPLEMENT_REQUEST = new RegExp(
  [
    String.raw`\b(?:make|keep|leave)\s+(?:this|it|the\s+(?:change|work|implementation|pr|pull request))\s+independent\b`,
    String.raw`\b(?:implement|build|create|do|handle|land)\s+(?:this|it|the\s+(?:change|work|implementation))\s+independently\b`,
    String.raw`\bindependent\s+(?:(?:stacked|follow[\s-]?up)\s+)?(?:pr|pull request|change|branch|implementation|work)\b`,
    String.raw`\b(?:stacked|follow[\s-]?up)\s+(?:pr|pull request|branch|change|work|implementation)\s+(?:(?:as|is|to be)\s+)?independent(?:ly)?\b`,
    String.raw`\bindependently\s+(?:from|of)\s+(?:this|the|current|source)\s+(?:pr|pull request|branch|change|work|implementation)\b`,
    String.raw`\bstandalone\s+(?:pr|pull request|change|branch|implementation)\b`,
    String.raw`\bunstacked\s+(?:pr|pull request|change|branch|implementation|work)\b`,
  ].join("|"),
  "i",
);
const LOCAL_INTENT_NEGATION = /\b(?:do\s+not|don['’]t|never|not|no|without|avoid(?:ing)?)\b(?:\s+[\w'’-]+){0,5}\s*$/i;

export interface RequestedLabelDecision {
  route: string;
  skill: string;
}

export interface RequestedRouteDecision {
  route: string;
  skill: string;
}

export interface ImplementIssueMetadata {
  issueTitle: string;
  issueBody: string;
  basePr?: string;
}

export interface RequestedRouteContext {
  agentMention?: string;
  triggerKind?: string;
  sourceKind?: string;
  targetKind?: string;
  targetNumber?: string;
  targetTitle?: string;
}

interface ExplicitRouteMatch {
  body: string;
  commandStart: number;
  commandEnd: number;
  route: string;
}

export function parseTriageMode(raw: string | undefined): TriageMode {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized || normalized === "commands") {
    return "commands";
  }
  if (normalized === "agent") {
    return "agent";
  }
  throw new Error(
    `AGENT_TRIAGE_MODE must be one of: commands, agent; got ${normalized}`,
  );
}

function fallbackImplementIssueBody(
  originalRequest: string,
  context: RequestedRouteContext,
): string {
  const labelTriggered = String(context.triggerKind || "").trim().toLowerCase() === "label";
  const sourceKind = String(context.sourceKind || context.targetKind || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  const goal = labelTriggered
    ? `Implement the requested change from the ${sourceKind || "target"} selected by the \`agent/implement\` label.`
    : "Implement the requested change from the agent mention.";

  return [
    "## Goal",
    goal,
    "",
    labelTriggered ? "## Source context" : "## Original request",
    originalRequest,
    "",
    "## Acceptance criteria",
    "- Implement the requested change.",
    "- Preserve existing behavior unless the request requires a change.",
    "- Update tests or validation as needed.",
  ].join("\n");
}

function findExplicitRouteCommand(body: string, mention: string): ExplicitRouteMatch | null {
  const originalBody = String(body || "");
  const trimmedMention = String(mention || "").trim();
  if (!originalBody.trim() || !trimmedMention) {
    return null;
  }

  const routePattern = EXPLICIT_ROUTE_COMMANDS.map((route) => escapeRegex(route)).join("|");
  const explicitRegex = new RegExp(
    `(^|[\\s(])(${escapeRegex(trimmedMention)}\\s+/(${routePattern})(?=$|[\\s.,;:!?)\\]}]))`,
    "gim",
  );
  let marker = "\0sepo-route-command\0";
  while (originalBody.includes(marker)) marker += "\0";

  for (const match of originalBody.matchAll(explicitRegex)) {
    const commandStart = (match.index || 0) + match[1].length;
    const commandEnd = commandStart + match[2].length;
    const markedBody = `${originalBody.slice(0, commandStart)}${marker}${originalBody.slice(commandEnd)}`;
    if (!stripNonLiveMentions(markedBody).includes(marker)) {
      continue;
    }

    return {
      body: originalBody,
      commandStart,
      commandEnd,
      route: match[3].toLowerCase(),
    };
  }

  return null;
}

function requestWithoutImplementCommand(requestText: string, agentMention: string): string {
  const match = findExplicitRouteCommand(requestText, agentMention);
  if (!match || match.route !== "implement") {
    return "";
  }

  return `${match.body.slice(0, match.commandStart)}${match.body.slice(match.commandEnd)}`;
}

function normalizeImplementIssueTitle(request: string): string {
  const titleMarkdown = String(request || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .split("\n")
    .filter((line) => !line.match(/^\s*>/))
    .join("\n")
    .replace(/`([^`\n]*)`/g, "$1");
  const normalized = titleMarkdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:;,\-–—]+\s*/, "")
    .replace(/^(?:#{1,6}|[-*+])\s+/, "")
    .trim();
  if (!normalized) {
    return DEFAULT_IMPLEMENT_ISSUE_TITLE;
  }
  if (normalized.length <= MAX_IMPLEMENT_ISSUE_TITLE_LENGTH) {
    return normalized;
  }

  const prefix = normalized
    .slice(0, MAX_IMPLEMENT_ISSUE_TITLE_LENGTH - 3)
    .trimEnd();
  return `${prefix}...`;
}

function isLocallyNegated(request: string, matchIndex: number): boolean {
  const prefix = request.slice(Math.max(0, matchIndex - 100), matchIndex);
  const punctuationStart = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf(":"),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf("\n"),
  );
  const conjunctions = [...prefix.matchAll(/\b(?:and|but|then)\b/gi)];
  const lastConjunction = conjunctions.at(-1);
  const conjunctionStart = lastConjunction?.index === undefined
    ? 0
    : lastConjunction.index + lastConjunction[0].length;
  const clauseStart = Math.max(punctuationStart + 1, conjunctionStart);
  return LOCAL_INTENT_NEGATION.test(prefix.slice(clauseStart));
}

function hasUnnegatedIntent(request: string, pattern: RegExp): boolean {
  const matcher = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  for (const match of request.matchAll(matcher)) {
    if (!isLocallyNegated(request, match.index || 0)) {
      return true;
    }
  }
  return false;
}

function inferImplementBasePr(request: string, context: RequestedRouteContext): string {
  const targetKind = String(context.targetKind || "").trim().toLowerCase();
  const targetNumber = String(context.targetNumber || "").trim();
  const triggerKind = String(context.triggerKind || "mention").trim().toLowerCase();
  if (
    triggerKind === "label" ||
    targetKind !== "pull_request" ||
    !/^[1-9]\d*$/.test(targetNumber)
  ) {
    return "";
  }
  if (hasUnnegatedIntent(request, INDEPENDENT_IMPLEMENT_REQUEST)) {
    return "";
  }
  return hasUnnegatedIntent(request, STACKED_IMPLEMENT_REQUEST) ? targetNumber : "";
}

/**
 * Builds tracking-issue metadata for an explicit /implement request without
 * invoking a model. Only the active request can supply title or stacking
 * intent; source-target context supplies the eligible PR number.
 */
export function buildImplementIssueMetadata(
  requestText: string,
  context: RequestedRouteContext = {},
): ImplementIssueMetadata {
  const originalRequest = String(requestText || "").trim() || "No request text provided.";
  const labelTriggered = String(context.triggerKind || "").trim().toLowerCase() === "label";
  const request = labelTriggered
    ? ""
    : requestWithoutImplementCommand(
        requestText,
        String(context.agentMention || ""),
      );
  const intentRequest = labelTriggered ? "" : stripNonLiveMentions(request);
  const titleSource = labelTriggered ? String(context.targetTitle || "") : request;

  return {
    issueTitle: normalizeImplementIssueTitle(titleSource),
    issueBody: fallbackImplementIssueBody(originalRequest, context),
    basePr: inferImplementBasePr(intentRequest, context),
  };
}

function fallbackAddRubricsIssueBody(originalRequest: string): string {
  return [
    "## Goal",
    "Propose the requested user/team rubric updates.",
    "",
    "## Original request",
    originalRequest,
    "",
    "## Acceptance criteria",
    "- Review existing rubrics before adding new ones.",
    "- Add or update rubric YAML on the `agent/rubrics` branch.",
    "- Validate rubric YAML before opening the proposal PR.",
  ].join("\n");
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
 * `@sepo-agent /review`, `@sepo-agent /install`, or
 * `@sepo-agent /skill release-notes`.
 */
export function extractRequestedRouteDecision(body: string, mention: string): RequestedRouteDecision {
  const sanitized = stripNonLiveMentions(String(body || ""));
  const trimmedMention = String(mention || "").trim();
  if (!sanitized.trim() || !trimmedMention) {
    return { route: "", skill: "" };
  }

  const explicitMatch = findExplicitRouteCommand(body, trimmedMention);
  if (explicitMatch) {
    return { route: explicitMatch.route, skill: "" };
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
export function buildRequestedRouteDecision(
  route: string,
  requestText: string,
  context: RequestedRouteContext = {},
): DispatchDecision {
  const normalizedRoute = String(route || "").trim().toLowerCase();
  if (
    normalizedRoute !== "skill" &&
    normalizedRoute !== "unsupported" &&
    !EXPLICIT_ROUTE_COMMANDS.includes(normalizedRoute as (typeof EXPLICIT_ROUTE_COMMANDS)[number])
  ) {
    throw new Error(`Unsupported explicit route: ${normalizedRoute || "missing"}`);
  }

  if (normalizedRoute === "implement") {
    const metadata = buildImplementIssueMetadata(requestText, context);
    return {
      route: "implement",
      // Explicit /implement is itself the approval, so the portal skips the
      // approval gate and dispatches agent-implement directly. The gate still
      // applies to triaged implement decisions (see applyDispatchPolicy).
      needsApproval: false,
      confidence: "high",
      summary: "I’ll start implementing this request.",
      issueTitle: metadata.issueTitle,
      issueBody: metadata.issueBody,
      basePr: metadata.basePr || "",
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

  if (normalizedRoute === "add-rubrics") {
    const originalRequest = String(requestText || "").trim() || "No request text provided.";
    return {
      route: "add-rubrics",
      needsApproval: false,
      confidence: "high",
      summary: "I’ll propose rubric updates in a pull request.",
      issueTitle: DEFAULT_ADD_RUBRICS_ISSUE_TITLE,
      issueBody: fallbackAddRubricsIssueBody(originalRequest),
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

  if (normalizedRoute === "orchestrate") {
    return {
      route: "orchestrate",
      needsApproval: false,
      confidence: "high",
      summary: "I’ll start orchestration for this target.",
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

  if (normalizedRoute === INSTALL_ROUTE) {
    return {
      route: INSTALL_ROUTE,
      needsApproval: false,
      confidence: "high",
      summary: "I’ll run the install route for the target repository.",
      issueTitle: "",
      issueBody: "",
    };
  }

  if (normalizedRoute === "unsupported") {
    return {
      route: "unsupported",
      needsApproval: false,
      confidence: "high",
      summary: "This explicit request is not supported by this repository agent.",
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
  if (normalized === "agent/orchestrate") {
    return { route: "orchestrate", skill: "" };
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

  if (normalized.route === "add-rubrics") {
    normalized.needsApproval = !isExplicit;
    if (!normalized.issueTitle) {
      normalized.issueTitle = DEFAULT_ADD_RUBRICS_ISSUE_TITLE;
    }
    if (!normalized.issueBody) {
      normalized.issueBody = fallbackAddRubricsIssueBody("No request text provided.");
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

  if (normalized.route === "orchestrate") {
    if (targetKind !== "issue" && targetKind !== "pull_request") {
      return {
        ...normalized,
        route: "unsupported",
        needsApproval: false,
        summary:
          "Orchestration requests are currently supported on issues and pull requests only.",
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
