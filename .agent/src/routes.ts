export type RouteApprovalMode = "never" | "triaged";
export type TargetKind = "issue" | "pull_request" | "discussion" | "repository";

export interface RouteLabel {
  description: string;
  color: string;
}

export interface RouteIssueTemplate {
  title: string;
  body: (requestText: string) => string;
}

export interface AgentRouteDefinition {
  id: string;
  dispatchVisible: boolean;
  dispatchDescription?: string;
  promptRuleOrder?: number;
  promptRuleLines?: readonly string[];
  promptTargetRule?: boolean;
  targetKinds?: readonly TargetKind[];
  targetUnsupportedSummary?: string;
  explicitCommand: boolean;
  explicitSummary?: string;
  label?: RouteLabel;
  approval: RouteApprovalMode;
  issueTemplate?: RouteIssueTemplate;
  fallbackIssueTitle?: string;
  fallbackIssueBody?: string;
}

function originalRequestText(requestText: string): string {
  return String(requestText || "").trim() || "No request text provided.";
}

function implementIssueBody(requestText: string): string {
  return [
    "## Goal",
    "Implement the requested change from the agent mention.",
    "",
    "## Original request",
    originalRequestText(requestText),
    "",
    "## Acceptance criteria",
    "- Implement the requested change.",
    "- Preserve existing behavior unless the request requires a change.",
    "- Update tests or validation as needed.",
  ].join("\n");
}

function createActionIssueBody(requestText: string): string {
  return [
    "## Goal",
    "Create a scheduled GitHub Actions workflow from the agent mention.",
    "",
    "## Original request",
    originalRequestText(requestText),
    "",
    "## Acceptance criteria",
    "- Add or update one standalone workflow under `.github/workflows/`.",
    "- Use native GitHub Actions triggers for schedule/manual runs.",
    "- Include an expiration guard before running the agent task.",
    "- Preserve activation through normal PR review and merge.",
  ].join("\n");
}

export const AGENT_ROUTE_CATALOG: readonly AgentRouteDefinition[] = [
  {
    id: "answer",
    dispatchVisible: true,
    dispatchDescription: "answer inline now",
    promptRuleOrder: 60,
    promptRuleLines: [
      "- Use `answer` for questions, clarification, lightweight analysis, or discussion.",
      "  - Sometimes the user may also ask the agent to review some code (and the user could be explicit about just review and launch a review agent). In this case, we should also resolve to `answer`.",
    ],
    explicitCommand: true,
    explicitSummary: "I’ll answer inline.",
    label: {
      description: "Ask Sepo to answer a question or provide plan-only guidance",
      color: "1f883d",
    },
    approval: "never",
  },
  {
    id: "implement",
    dispatchVisible: true,
    dispatchDescription: "request approval to run the implementation workflow",
    promptRuleOrder: 10,
    promptRuleLines: [
      "- Use `implement` when the user is explicitly asking the agent to make code changes.",
    ],
    explicitCommand: true,
    explicitSummary: "I’ll start implementing this request.",
    label: {
      description: "Ask Sepo to implement an issue through a pull request",
      color: "0969da",
    },
    approval: "triaged",
    issueTemplate: {
      title: "Implement requested change",
      body: implementIssueBody,
    },
  },
  {
    id: "fix-pr",
    dispatchVisible: true,
    dispatchDescription: "start the PR-fix workflow immediately",
    promptRuleOrder: 20,
    promptRuleLines: [
      "- Use `fix-pr` when the user is explicitly asking the agent to update an existing PR to address review feedback or requested changes.",
    ],
    promptTargetRule: true,
    targetKinds: ["pull_request"],
    targetUnsupportedSummary:
      "PR fix requests are only supported from pull requests right now.",
    explicitCommand: true,
    explicitSummary: "I’ll start a PR fix pass.",
    label: {
      description: "Ask Sepo to push fixes to a pull request branch",
      color: "d1242f",
    },
    approval: "never",
  },
  {
    id: "review",
    dispatchVisible: true,
    dispatchDescription: "start the review workflow immediately",
    promptRuleOrder: 30,
    promptRuleLines: [
      "- Use `review` only when the user is explicitly asking for a PR review or another review pass.",
    ],
    targetKinds: ["pull_request"],
    targetUnsupportedSummary:
      "Review requests are only supported from pull requests right now.",
    explicitCommand: true,
    explicitSummary: "I’ll start a review pass.",
    label: {
      description: "Ask Sepo to review a pull request",
      color: "bf3989",
    },
    approval: "never",
  },
  {
    id: "orchestrate",
    dispatchVisible: true,
    dispatchDescription: "start the orchestrator workflow immediately",
    promptRuleOrder: 40,
    promptRuleLines: [
      "- Use `orchestrate` when the user explicitly asks for orchestration, follow-up automation, or a bounded multi-step agent workflow on an issue or pull request.",
    ],
    promptTargetRule: true,
    targetKinds: ["issue", "pull_request"],
    targetUnsupportedSummary:
      "Orchestration requests are currently supported on issues and pull requests only.",
    explicitCommand: true,
    explicitSummary: "I’ll start orchestration for this target.",
    label: {
      description: "Ask Sepo to run bounded follow-up orchestration",
      color: "fb8c00",
    },
    approval: "never",
  },
  {
    id: "create-action",
    dispatchVisible: true,
    dispatchDescription:
      "request approval to create a scheduled GitHub Actions workflow for recurring agent automation",
    promptRuleOrder: 50,
    promptRuleLines: [
      "- Use `create-action` when the user asks to create an automatically running or durable automation, monitor, scheduled job, or recurring check.",
    ],
    explicitCommand: true,
    explicitSummary: "I’ll create a pull request for a scheduled agent workflow.",
    label: {
      description: "Ask Sepo to propose a scheduled agent workflow",
      color: "8250df",
    },
    approval: "triaged",
    issueTemplate: {
      title: "Create scheduled agent workflow",
      body: createActionIssueBody,
    },
    fallbackIssueTitle: "Create scheduled agent workflow",
    fallbackIssueBody:
      "Create a scheduled GitHub Actions workflow for the requested automation.",
  },
  {
    id: "unsupported",
    dispatchVisible: true,
    dispatchDescription: "explain the limitation inline",
    promptRuleOrder: 70,
    promptRuleLines: [
      "- Use `unsupported` when the user asks for a workflow this repo does not support yet.",
    ],
    explicitCommand: false,
    approval: "never",
  },
  {
    id: "skill",
    dispatchVisible: false,
    explicitCommand: false,
    explicitSummary: "I’ll run the requested skill.",
    approval: "never",
  },
] as const;

export const LABEL_ROUTE_PREFIX = "agent/";
export const LABEL_SKILL_PREFIX = "agent/s/";

export function getAgentRouteDefinition(route: string): AgentRouteDefinition | undefined {
  const normalized = String(route || "").trim().toLowerCase();
  return AGENT_ROUTE_CATALOG.find((definition) => definition.id === normalized);
}

export function getDispatchRouteDefinitions(): AgentRouteDefinition[] {
  return AGENT_ROUTE_CATALOG.filter((definition) => definition.dispatchVisible);
}

export function getDispatchRouteIds(): string[] {
  return getDispatchRouteDefinitions().map((definition) => definition.id);
}

export function getExplicitRouteCommandIds(): string[] {
  return AGENT_ROUTE_CATALOG.filter((definition) => definition.explicitCommand).map(
    (definition) => definition.id,
  );
}

export function getLabelRouteDefinitions(): AgentRouteDefinition[] {
  return AGENT_ROUTE_CATALOG.filter((definition) => Boolean(definition.label));
}

export function triggerLabelForRoute(route: string): string {
  return `${LABEL_ROUTE_PREFIX}${route}`;
}

export function getRouteForTriggerLabel(labelName: string): AgentRouteDefinition | undefined {
  const normalized = String(labelName || "").trim().toLowerCase();
  return getLabelRouteDefinitions().find(
    (definition) => triggerLabelForRoute(definition.id) === normalized,
  );
}

function formatTargetKind(kind: string): string {
  return kind === "pull_request" ? "pull request" : kind.replace(/_/g, " ");
}

function articleFor(text: string): string {
  return /^[aeiou]/i.test(text) ? "an" : "a";
}

function singleTargetKindCondition(kind: TargetKind): string {
  const targetKind = formatTargetKind(kind);
  return `not on ${articleFor(targetKind)} ${targetKind}`;
}

function formatTargetKindCodeList(targetKinds: readonly TargetKind[]): string {
  const quoted = targetKinds.map((targetKind) => `\`${targetKind}\``);
  if (quoted.length <= 1) return quoted[0] || "";
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

function targetConstraintDescription(targetKinds: readonly TargetKind[] | undefined): string {
  if (!targetKinds?.length) return "";
  return `; only valid for ${formatTargetKindCodeList(targetKinds)}`;
}

function targetKindRule(definition: AgentRouteDefinition): string | null {
  const targetKinds = definition.targetKinds;
  if (!targetKinds?.length) return null;

  const targetDescription =
    targetKinds.length === 1
      ? singleTargetKindCondition(targetKinds[0])
      : "on another target kind";
  return `- \`${definition.id}\` is only valid for ${formatTargetKindCodeList(targetKinds)}. If the request is ${targetDescription}, use \`unsupported\`.`;
}

export function isRouteSupportedForTargetKind(
  definition: AgentRouteDefinition,
  targetKind: string,
): boolean {
  if (!definition.targetKinds?.length) return true;
  return definition.targetKinds.includes(String(targetKind || "") as TargetKind);
}

export function renderDispatchRouteList(): string {
  return getDispatchRouteDefinitions()
    .map((definition) => {
      const description = definition.dispatchDescription || "";
      return `- \`${definition.id}\`: ${description}${targetConstraintDescription(definition.targetKinds)}`;
    })
    .join("\n");
}

export function renderDispatchRouteUnion(): string {
  return getDispatchRouteIds().join(" | ");
}

export function renderDispatchRouteRules(): string {
  const routeRules = getDispatchRouteDefinitions()
    .filter((definition) => Boolean(definition.promptRuleLines?.length))
    .sort((a, b) => (a.promptRuleOrder || 0) - (b.promptRuleOrder || 0))
    .flatMap((definition) => definition.promptRuleLines || []);
  const targetRules = getDispatchRouteDefinitions()
    .filter((definition) => definition.promptTargetRule)
    .map((definition) => targetKindRule(definition))
    .filter((rule): rule is string => Boolean(rule));

  return [...routeRules, ...targetRules].join("\n");
}

export function buildDispatchPromptVars(): Record<string, string> {
  return {
    DISPATCH_ROUTE_LIST: renderDispatchRouteList(),
    DISPATCH_ROUTE_UNION: renderDispatchRouteUnion(),
    DISPATCH_ROUTE_RULES: renderDispatchRouteRules(),
  };
}
