import {
  createGhGraphqlClient,
  type GraphQLClient,
} from "./github-graphql.js";
import { isReviewSynthesisBody } from "./review-synthesis.js";

type PageInfo = {
  hasNextPage: boolean;
  endCursor?: string | null;
};

type ReviewSummaryNode = {
  id?: string | null;
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

type CollapsePreviousReviewSummariesOptions = {
  repo: string;
  prNumber: number;
  client?: GraphQLClient;
};

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
  return String(login || "").trim().replace(/\[bot\]$/i, "");
}

function isSameActorLogin(left: string, right: string): boolean {
  return normalizeActorLogin(left) === normalizeActorLogin(right);
}

function isGeneratedReviewSummary(node: ReviewSummaryNode, viewerLogin: string): boolean {
  if (!node.id || node.isMinimized) return false;
  if (!isSameActorLogin(node.author?.login || "", viewerLogin)) return false;
  return isReviewSynthesisBody(node.body || "");
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
      if (isGeneratedReviewSummary(node, viewerLogin)) {
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
  const client = options.client || createGhGraphqlClient();
  const repo = parseRepo(options.repo);
  const viewerLogin = fetchViewerLogin(client);
  const nodes = [
    ...fetchMatchingNodes(client, COMMENTS_QUERY, "comments", repo, options.prNumber, viewerLogin),
    ...fetchMatchingNodes(client, REVIEWS_QUERY, "reviews", repo, options.prNumber, viewerLogin),
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
