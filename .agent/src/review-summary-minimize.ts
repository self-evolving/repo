import {
  createGhGraphqlClient,
  type GraphQLClient,
} from "./github-graphql.js";
import { hasAnyHandoffMarker, parseAnyHandoffMarker } from "./handoff.js";
import { isFixPrStatusBody } from "./fix-pr-status.js";
import {
  REVIEW_SYNTHESIS_MARKER,
  extractReviewSynthesisHeadSha,
  isReviewSynthesisBody,
} from "./review-synthesis.js";

type PageInfo = {
  hasNextPage: boolean;
  endCursor?: string | null;
};

type ReviewSummaryNode = {
  id?: string | null;
  databaseId?: number | string | null;
  body?: string | null;
  isMinimized?: boolean | null;
  author?: {
    login?: string | null;
  } | null;
};

type ReviewSummaryConnection = {
  nodes?: ReviewSummaryNode[] | null;
  pageInfo: PageInfo;
};

type ViewerResponse = {
  viewer?: {
    login?: string | null;
  } | null;
};

type PullRequestCommentsResponse = {
  repository?: {
    pullRequest?: {
      comments?: ReviewSummaryConnection | null;
    } | null;
  } | null;
};

type PullRequestReviewsResponse = {
  repository?: {
    pullRequest?: {
      reviews?: ReviewSummaryConnection | null;
    } | null;
  } | null;
};

type IssueCommentsResponse = {
  repository?: {
    issue?: {
      comments?: ReviewSummaryConnection | null;
    } | null;
  } | null;
};

type CollapsePreviousReviewSummariesOptions = {
  repo: string;
  prNumber: number;
  client?: GraphQLClient;
};

type CollapsePreviousPrConversationArtifactsOptions = CollapsePreviousReviewSummariesOptions & {
  currentFinalCommentDatabaseId?: string;
  excludeBodyMarker?: string;
  expectedHeadSha?: string;
  sourceArtifactDatabaseId?: string;
};

export interface ReviewSynthesisSourceValidationResult {
  valid: boolean;
  reason: string;
}

export interface CollapsePreviousPrConversationArtifactsResult {
  collapsed: number;
  skippedReason?: string;
}

type CollapsePreviousHandoffCommentsOptions = {
  repo: string;
  targetNumber: number;
  targetKind: "issue" | "pull_request";
  excludeCommentId?: string;
  currentCreatedAtMs?: number;
  client?: GraphQLClient;
};

type ReviewBodyMatcher = (body: string) => boolean;

const VIEWER_QUERY = `
  query ViewerLogin {
    viewer {
      login
    }
  }
`;

const COMMENTS_QUERY = `
  query PullRequestReviewSummaryComments(
    $owner: String!
    $name: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        comments(first: 100, after: $after) {
          nodes {
            id
            databaseId
            body
            isMinimized
            author {
              login
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const REVIEWS_QUERY = `
  query PullRequestReviewSummaries(
    $owner: String!
    $name: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $after) {
          nodes {
            id
            body
            isMinimized
            author {
              login
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const ISSUE_COMMENTS_QUERY = `
  query IssueGeneratedComments(
    $owner: String!
    $name: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        comments(first: 100, after: $after) {
          nodes {
            id
            body
            isMinimized
            author {
              login
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const MINIMIZE_COMMENT_MUTATION = `
  mutation MinimizeReviewSummary($id: ID!, $classifier: ReportedContentClassifiers!) {
    minimizeComment(input: { subjectId: $id, classifier: $classifier }) {
      minimizedComment {
        isMinimized
      }
    }
  }
`;

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    throw new Error(`Expected GITHUB_REPOSITORY-style repo slug, got ${JSON.stringify(repo)}`);
  }
  return { owner, name };
}

function normalizeActorLogin(login: string): string {
  return String(login || "")
    .trim()
    .toLowerCase()
    .replace(/^app\//i, "")
    .replace(/\[bot\]$/i, "");
}

function isSameActorLogin(left: string, right: string): boolean {
  return normalizeActorLogin(left) === normalizeActorLogin(right);
}

export function isRubricsReviewBody(body: string): boolean {
  return /(?:^|\r?\n)## Rubrics Review(?:\s|$)/.test(body);
}

function isGeneratedReviewComment(
  node: ReviewSummaryNode,
  viewerLogin: string,
  bodyMatcher: ReviewBodyMatcher,
  includeMinimized = false,
): boolean {
  if (!node.id || (!includeMinimized && node.isMinimized)) return false;
  if (!isSameActorLogin(node.author?.login || "", viewerLogin)) return false;
  return bodyMatcher(node.body || "");
}

function fetchViewerLogin(client: GraphQLClient): string {
  const data = client.graphql<ViewerResponse>(VIEWER_QUERY, {});
  const login = data.viewer?.login || "";
  if (!login) {
    throw new Error("Could not resolve authenticated GitHub viewer login");
  }
  return login;
}

function fetchMatchingNodes(
  client: GraphQLClient,
  query: string,
  connectionName: "comments" | "reviews",
  repo: { owner: string; name: string },
  prNumber: number,
  viewerLogin: string,
  bodyMatcher: ReviewBodyMatcher,
  includeMinimized = false,
): ReviewSummaryNode[] {
  const matches: ReviewSummaryNode[] = [];
  let after: string | undefined;

  do {
    const data = client.graphql<PullRequestCommentsResponse | PullRequestReviewsResponse>(
      query,
      {
        owner: repo.owner,
        name: repo.name,
        number: prNumber,
        after,
      },
    );
    const pullRequest = data.repository?.pullRequest;
    const connection = connectionName === "comments"
      ? (pullRequest as { comments?: ReviewSummaryConnection | null } | null | undefined)?.comments
      : (pullRequest as { reviews?: ReviewSummaryConnection | null } | null | undefined)?.reviews;
    if (!connection) return matches;

    for (const node of connection.nodes || []) {
      if (isGeneratedReviewComment(node, viewerLogin, bodyMatcher, includeMinimized)) {
        matches.push(node);
      }
    }
    after = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor || undefined
      : undefined;
  } while (after);

  return matches;
}

function collapsePreviousMatchingReviewComments(
  options: CollapsePreviousReviewSummariesOptions,
  bodyMatcher: ReviewBodyMatcher,
): number {
  const client = options.client || createGhGraphqlClient();
  const repo = parseRepo(options.repo);
  const viewerLogin = fetchViewerLogin(client);
  const nodes = [
    ...fetchMatchingNodes(
      client,
      COMMENTS_QUERY,
      "comments",
      repo,
      options.prNumber,
      viewerLogin,
      bodyMatcher,
    ),
    ...fetchMatchingNodes(
      client,
      REVIEWS_QUERY,
      "reviews",
      repo,
      options.prNumber,
      viewerLogin,
      bodyMatcher,
    ),
  ];
  const uniqueNodeIds = Array.from(new Set(nodes.map((node) => node.id).filter(Boolean))) as string[];

  for (const id of uniqueNodeIds) {
    client.graphql(MINIMIZE_COMMENT_MUTATION, {
      id,
      classifier: "OUTDATED",
    });
  }

  return uniqueNodeIds.length;
}

function collapsePreviousMatchingPrComments(
  options: CollapsePreviousReviewSummariesOptions,
  bodyMatcher: ReviewBodyMatcher,
  atOrBeforeCommentDatabaseId?: bigint,
): number {
  const client = options.client || createGhGraphqlClient();
  const repo = parseRepo(options.repo);
  const viewerLogin = fetchViewerLogin(client);
  const nodes = fetchMatchingNodes(
    client,
    COMMENTS_QUERY,
    "comments",
    repo,
    options.prNumber,
    viewerLogin,
    bodyMatcher,
  );
  if (
    atOrBeforeCommentDatabaseId !== undefined &&
    !nodes.some((node) => parsePositiveDatabaseId(node.databaseId) === atOrBeforeCommentDatabaseId)
  ) {
    return 0;
  }
  const uniqueNodeIds = Array.from(new Set(
    nodes
      .filter((node) => (
        atOrBeforeCommentDatabaseId === undefined ||
        isDatabaseIdAtOrBefore(node.databaseId, atOrBeforeCommentDatabaseId)
      ))
      .map((node) => node.id)
      .filter(Boolean),
  )) as string[];

  for (const id of uniqueNodeIds) {
    client.graphql(MINIMIZE_COMMENT_MUTATION, {
      id,
      classifier: "OUTDATED",
    });
  }

  return uniqueNodeIds.length;
}

function parsePositiveDatabaseId(value: unknown): bigint | null {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function isDatabaseIdAtOrBefore(value: unknown, boundary: bigint): boolean {
  const databaseId = parsePositiveDatabaseId(value);
  return databaseId !== null && databaseId <= boundary;
}

const ORCHESTRATION_SOURCE_ARTIFACT_MARKER_PREFIX = "sepo-agent-orchestration-source-artifact";

export function buildOrchestrationSourceArtifactMarker(sourceArtifactDatabaseId: string): string {
  const databaseId = parsePositiveDatabaseId(sourceArtifactDatabaseId);
  return databaseId === null
    ? ""
    : `<!-- ${ORCHESTRATION_SOURCE_ARTIFACT_MARKER_PREFIX}: ${databaseId} -->`;
}

function evaluateReviewSynthesisSource(
  nodes: ReviewSummaryNode[],
  sourceArtifactDatabaseId: string | undefined,
  expectedHeadSha: string | undefined,
): ReviewSynthesisSourceValidationResult {
  const invalidInput = validateReviewSynthesisSourceInputs(
    sourceArtifactDatabaseId,
    expectedHeadSha,
  );
  if (invalidInput) return invalidInput;
  const sourceDatabaseId = parsePositiveDatabaseId(sourceArtifactDatabaseId) as bigint;
  const normalizedExpectedHead = String(expectedHeadSha || "").trim().toLowerCase();

  const currentHeadSyntheses = nodes
    .filter((node) => {
      const body = String(node.body || "");
      return body.includes(REVIEW_SYNTHESIS_MARKER) &&
        extractReviewSynthesisHeadSha(body).toLowerCase() === normalizedExpectedHead;
    })
    .map((node) => ({ node, databaseId: parsePositiveDatabaseId(node.databaseId) }))
    .filter((entry): entry is { node: ReviewSummaryNode; databaseId: bigint } => entry.databaseId !== null)
    .sort((left, right) => left.databaseId < right.databaseId ? -1 : left.databaseId > right.databaseId ? 1 : 0);
  if (!currentHeadSyntheses.length) {
    return {
      valid: false,
      reason: "no trusted review synthesis with explicit markers matches the expected head",
    };
  }

  const latest = currentHeadSyntheses[currentHeadSyntheses.length - 1];
  if (latest.databaseId !== sourceDatabaseId) {
    return {
      valid: false,
      reason: "source artifact is not the latest trusted review synthesis for the expected head",
    };
  }
  return { valid: true, reason: "source artifact is the latest trusted current-head review synthesis" };
}

function validateReviewSynthesisSourceInputs(
  sourceArtifactDatabaseId: string | undefined,
  expectedHeadSha: string | undefined,
): ReviewSynthesisSourceValidationResult | null {
  if (parsePositiveDatabaseId(sourceArtifactDatabaseId) === null) {
    return { valid: false, reason: "source artifact database ID is missing or invalid" };
  }
  if (!/^[0-9a-f]{6,64}$/i.test(String(expectedHeadSha || "").trim())) {
    return { valid: false, reason: "expected reviewed head SHA is missing or invalid" };
  }
  return null;
}

function fetchTrustedPrCommentNodes(
  options: CollapsePreviousReviewSummariesOptions,
): ReviewSummaryNode[] {
  const client = options.client || createGhGraphqlClient();
  const repo = parseRepo(options.repo);
  const viewerLogin = fetchViewerLogin(client);
  return fetchMatchingNodes(
    client,
    COMMENTS_QUERY,
    "comments",
    repo,
    options.prNumber,
    viewerLogin,
    () => true,
    true,
  );
}

export function validateLatestReviewSynthesisSource(
  options: CollapsePreviousReviewSummariesOptions & {
    expectedHeadSha?: string;
    sourceArtifactDatabaseId?: string;
  },
): ReviewSynthesisSourceValidationResult {
  const invalidInput = validateReviewSynthesisSourceInputs(
    options.sourceArtifactDatabaseId,
    options.expectedHeadSha,
  );
  if (invalidInput) return invalidInput;
  return evaluateReviewSynthesisSource(
    fetchTrustedPrCommentNodes(options),
    options.sourceArtifactDatabaseId,
    options.expectedHeadSha,
  );
}

function isTerminalPrConversationArtifact(body: string): boolean {
  const handoffMarker = parseAnyHandoffMarker(body);
  return (
    isReviewSynthesisBody(body) ||
    isRubricsReviewBody(body) ||
    isFixPrStatusBody(body) ||
    Boolean(handoffMarker && handoffMarker.state !== "pending")
  );
}

function collapsePreviousMatchingHandoffComments(
  options: CollapsePreviousHandoffCommentsOptions,
): number {
  const client = options.client || createGhGraphqlClient();
  const repo = parseRepo(options.repo);
  const viewerLogin = fetchViewerLogin(client);
  const nodes = options.targetKind === "issue"
    ? fetchMatchingIssueCommentNodes(
      client,
      repo,
      options.targetNumber,
      viewerLogin,
      hasAnyHandoffMarker,
    )
    : fetchMatchingNodes(
      client,
      COMMENTS_QUERY,
      "comments",
      repo,
      options.targetNumber,
      viewerLogin,
      hasAnyHandoffMarker,
    );
  const excludeCommentId = String(options.excludeCommentId || "");
  const currentFromComment = nodes.find((node) => node.id === excludeCommentId);
  const currentMarker = currentFromComment
    ? parseAnyHandoffMarker(currentFromComment.body || "")
    : null;
  const explicitCreatedAtMs = Number(options.currentCreatedAtMs);
  const currentCreatedAtMs = Number.isFinite(explicitCreatedAtMs) && explicitCreatedAtMs > 0
    ? explicitCreatedAtMs
    : currentMarker?.createdAtMs ?? null;
  const uniqueNodeIds = Array.from(new Set(
    nodes
      .filter((node) => {
        if (!node.id || node.id === excludeCommentId) return false;
        const marker = parseAnyHandoffMarker(node.body || "");
        if (!marker || marker.state === "pending") return false;
        if (currentCreatedAtMs) {
          return Boolean(marker.createdAtMs && marker.createdAtMs < currentCreatedAtMs);
        }
        return true;
      })
      .map((node) => node.id)
      .filter((id): id is string => Boolean(id)),
  ));

  for (const id of uniqueNodeIds) {
    client.graphql(MINIMIZE_COMMENT_MUTATION, {
      id,
      classifier: "OUTDATED",
    });
  }

  return uniqueNodeIds.length;
}

function fetchMatchingIssueCommentNodes(
  client: GraphQLClient,
  repo: { owner: string; name: string },
  issueNumber: number,
  viewerLogin: string,
  bodyMatcher: ReviewBodyMatcher,
): ReviewSummaryNode[] {
  const matches: ReviewSummaryNode[] = [];
  let after: string | undefined;

  do {
    const data = client.graphql<IssueCommentsResponse>(
      ISSUE_COMMENTS_QUERY,
      {
        owner: repo.owner,
        name: repo.name,
        number: issueNumber,
        after,
      },
    );
    const connection = data.repository?.issue?.comments;
    if (!connection) return matches;

    for (const node of connection.nodes || []) {
      if (isGeneratedReviewComment(node, viewerLogin, bodyMatcher)) {
        matches.push(node);
      }
    }
    after = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor || undefined
      : undefined;
  } while (after);

  return matches;
}

/**
 * Collapses older agent-generated PR review summaries before posting a fresh one.
 */
export function collapsePreviousReviewSummaries(
  options: CollapsePreviousReviewSummariesOptions,
): number {
  return collapsePreviousMatchingReviewComments(options, isReviewSynthesisBody);
}

/**
 * Collapses older agent-generated rubrics reviews before posting a fresh one.
 */
export function collapsePreviousRubricsReviews(
  options: CollapsePreviousReviewSummariesOptions,
): number {
  return collapsePreviousMatchingReviewComments(options, isRubricsReviewBody);
}

/**
 * Collapses older agent-generated fix-pr status comments before posting a fresh one.
 */
export function collapsePreviousFixPrComments(
  options: CollapsePreviousReviewSummariesOptions,
): number {
  return collapsePreviousMatchingPrComments(options, isFixPrStatusBody);
}

/**
 * Collapses trusted generated PR conversation comments after terminal success.
 * Formal review objects are intentionally left to the review workflow.
 */
export function collapsePreviousPrConversationArtifacts(
  options: CollapsePreviousPrConversationArtifactsOptions,
): CollapsePreviousPrConversationArtifactsResult {
  const excludeBodyMarker = String(options.excludeBodyMarker || "");
  const sourceArtifactDatabaseId = parsePositiveDatabaseId(options.sourceArtifactDatabaseId);
  if (sourceArtifactDatabaseId === null) {
    return { collapsed: 0, skippedReason: "source artifact database ID is missing or invalid" };
  }
  const currentFinalCommentDatabaseId = parsePositiveDatabaseId(options.currentFinalCommentDatabaseId);
  if (currentFinalCommentDatabaseId === null) {
    return { collapsed: 0, skippedReason: "current finalized comment database ID is missing or invalid" };
  }
  const invalidSourceInput = validateReviewSynthesisSourceInputs(
    options.sourceArtifactDatabaseId,
    options.expectedHeadSha,
  );
  if (invalidSourceInput) {
    return { collapsed: 0, skippedReason: invalidSourceInput.reason };
  }

  const client = options.client || createGhGraphqlClient();
  const nodes = fetchTrustedPrCommentNodes({ ...options, client });
  const sourceValidation = evaluateReviewSynthesisSource(
    nodes,
    options.sourceArtifactDatabaseId,
    options.expectedHeadSha,
  );
  if (!sourceValidation.valid) {
    return { collapsed: 0, skippedReason: sourceValidation.reason };
  }

  const sourceMarker = buildOrchestrationSourceArtifactMarker(options.sourceArtifactDatabaseId || "");
  const currentFinalNode = nodes.find((node) => (
    parsePositiveDatabaseId(node.databaseId) === currentFinalCommentDatabaseId
  ));
  const currentFinalBody = String(currentFinalNode?.body || "");
  if (
    !currentFinalNode ||
    currentFinalNode.isMinimized ||
    !excludeBodyMarker ||
    !currentFinalBody.includes(excludeBodyMarker) ||
    !sourceMarker ||
    !currentFinalBody.includes(sourceMarker)
  ) {
    return {
      collapsed: 0,
      skippedReason: "current finalized comment could not be verified as part of the causal source chain",
    };
  }
  const uniqueNodeIds = Array.from(new Set(
    nodes
      .filter((node) => {
        const databaseId = parsePositiveDatabaseId(node.databaseId);
        if (
          !node.id ||
          node.isMinimized ||
          databaseId === null ||
          databaseId === currentFinalCommentDatabaseId
        ) {
          return false;
        }
        const body = String(node.body || "");
        const terminalArtifact = (
          Boolean(excludeBodyMarker && body.includes(excludeBodyMarker)) ||
          isTerminalPrConversationArtifact(body)
        );
        return terminalArtifact && (
          databaseId <= sourceArtifactDatabaseId ||
          Boolean(sourceMarker && body.includes(sourceMarker))
        );
      })
      .map((node) => node.id)
      .filter((id): id is string => Boolean(id)),
  ));

  for (const id of uniqueNodeIds) {
    client.graphql(MINIMIZE_COMMENT_MUTATION, {
      id,
      classifier: "OUTDATED",
    });
  }

  return { collapsed: uniqueNodeIds.length };
}

/**
 * Collapses older orchestrator handoff marker comments after a fresh dispatch.
 */
export function collapsePreviousHandoffComments(
  options: CollapsePreviousHandoffCommentsOptions,
): number {
  return collapsePreviousMatchingHandoffComments(options);
}
