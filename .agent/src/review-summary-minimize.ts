import {
  createGhGraphqlClient,
  type GraphQLClient,
} from "./github-graphql.js";
import { hasAnyHandoffMarker, parseAnyHandoffMarker } from "./handoff.js";
import { isReviewSynthesisBody } from "./review-synthesis.js";

type PageInfo = {
  hasNextPage: boolean;
  endCursor?: string | null;
};

type ReviewSummaryNode = {
  id?: string | null;
  body?: string | null;
  createdAt?: string | null;
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

type ReviewThreadNode = {
  id?: string | null;
  comments?: ReviewSummaryConnection | null;
};

type ReviewThreadConnection = {
  nodes?: ReviewThreadNode[] | null;
  pageInfo: PageInfo;
};

type PullRequestReviewThreadsResponse = {
  repository?: {
    pullRequest?: {
      reviewThreads?: ReviewThreadConnection | null;
    } | null;
  } | null;
};

type ReviewThreadCommentsResponse = {
  node?: {
    comments?: ReviewSummaryConnection | null;
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
  currentReviewStartedAtMs?: number;
  client?: GraphQLClient;
};

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

const REVIEW_THREADS_QUERY = `
  query PullRequestInlineReviewComments(
    $owner: String!
    $name: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            id
            comments(first: 100) {
              nodes {
                id
                body
                createdAt
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
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const REVIEW_THREAD_COMMENTS_QUERY = `
  query PullRequestInlineReviewThreadComments($id: ID!, $after: String) {
    node(id: $id) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          nodes {
            id
            body
            createdAt
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
): boolean {
  if (!node.id || node.isMinimized) return false;
  if (!isSameActorLogin(node.author?.login || "", viewerLogin)) return false;
  return bodyMatcher(node.body || "");
}

function isOlderThan(node: ReviewSummaryNode, cutoffMs: number): boolean {
  const createdAtMs = Date.parse(node.createdAt || "");
  return Number.isFinite(createdAtMs) && createdAtMs < cutoffMs;
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

function collectMatchingInlineReviewComments(
  matches: ReviewSummaryNode[],
  connection: ReviewSummaryConnection | null | undefined,
  viewerLogin: string,
  currentReviewStartedAtMs: number,
): string | undefined {
  if (!connection) return undefined;
  for (const node of connection.nodes || []) {
    if (
      isGeneratedReviewComment(node, viewerLogin, () => true)
      && isOlderThan(node, currentReviewStartedAtMs)
    ) {
      matches.push(node);
    }
  }
  return connection.pageInfo.hasNextPage
    ? connection.pageInfo.endCursor || undefined
    : undefined;
}

function fetchMatchingInlineReviewCommentNodes(
  client: GraphQLClient,
  repo: { owner: string; name: string },
  prNumber: number,
  viewerLogin: string,
  currentReviewStartedAtMs: number,
): ReviewSummaryNode[] {
  const matches: ReviewSummaryNode[] = [];
  let after: string | undefined;

  do {
    const data = client.graphql<PullRequestReviewThreadsResponse>(
      REVIEW_THREADS_QUERY,
      {
        owner: repo.owner,
        name: repo.name,
        number: prNumber,
        after,
      },
    );
    const connection = data.repository?.pullRequest?.reviewThreads;
    if (!connection) return matches;

    for (const thread of connection.nodes || []) {
      let commentsAfter = collectMatchingInlineReviewComments(
        matches,
        thread.comments,
        viewerLogin,
        currentReviewStartedAtMs,
      );
      while (thread.id && commentsAfter) {
        const commentsData = client.graphql<ReviewThreadCommentsResponse>(
          REVIEW_THREAD_COMMENTS_QUERY,
          {
            id: thread.id,
            after: commentsAfter,
          },
        );
        commentsAfter = collectMatchingInlineReviewComments(
          matches,
          commentsData.node?.comments,
          viewerLogin,
          currentReviewStartedAtMs,
        );
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
  const currentReviewStartedAtMs = Number(options.currentReviewStartedAtMs);
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
    ...(Number.isFinite(currentReviewStartedAtMs) && currentReviewStartedAtMs > 0
      ? fetchMatchingInlineReviewCommentNodes(
        client,
        repo,
        options.prNumber,
        viewerLogin,
        currentReviewStartedAtMs,
      )
      : []),
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
 * Collapses older orchestrator handoff marker comments after a fresh dispatch.
 */
export function collapsePreviousHandoffComments(
  options: CollapsePreviousHandoffCommentsOptions,
): number {
  return collapsePreviousMatchingHandoffComments(options);
}
