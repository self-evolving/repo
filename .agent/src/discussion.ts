// Discussion-specific GraphQL operations needed by the portal.
//
// Uses gh api graphql for all calls, consistent with the self-serve pattern.

import {
  createGhGraphqlClient,
  ghGraphqlData,
  type GraphQLClient,
} from "./github-graphql.js";

export interface DiscussionComment {
  id: string;
  body: string;
  created_at: string;
}

export interface DiscussionCategory {
  id: string;
  name: string;
}

export interface RepositoryDiscussionConfig {
  repositoryId: string;
  hasDiscussionsEnabled: boolean;
  categories: DiscussionCategory[];
}

/**
 * Resolves the reply-to target for a discussion comment.
 * Returns the parent comment node ID if the comment is a nested reply,
 * or the comment's own ID if it's a top-level reply.
 */
export function resolveDiscussionReplyTo(commentNodeId: string): string {
  const query = `
    query($nodeId: ID!) {
      node(id: $nodeId) {
        ... on DiscussionComment {
          replyTo { id }
        }
      }
    }
  `;
  const data = ghGraphqlData<{ node?: { replyTo?: { id: string } | null } }>(
    query,
    { nodeId: commentNodeId },
  );
  // If the comment has a replyTo, it's a nested reply — use the parent.
  // Otherwise return the comment itself as the reply target.
  return data.node?.replyTo?.id || commentNodeId;
}

/**
 * Fetches all comments for a discussion with cursor-based pagination.
 * Returns flattened list suitable for findLatestPendingRequest scanning.
 */
export function fetchDiscussionComments(
  owner: string,
  repo: string,
  number: number,
): DiscussionComment[] {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        discussion(number: $number) {
          comments(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              body
              createdAt
            }
          }
        }
      }
    }
  `;

  const allComments: DiscussionComment[] = [];
  let cursor = "";
  let hasNextPage = true;

  while (hasNextPage) {
    const vars: {
      owner: string;
      repo: string;
      number: number;
      cursor?: string;
    } = {
      owner,
      repo,
      number,
    };
    if (cursor) {
      vars.cursor = cursor;
    }

    const data = ghGraphqlData<{
      repository?: {
        discussion?: {
          comments?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: Array<{ id: string; body: string; createdAt: string }>;
          };
        };
      };
    }>(query, vars);

    const comments = data.repository?.discussion?.comments;
    const nodes = comments?.nodes || [];
    for (const n of nodes) {
      allComments.push({
        id: n.id,
        body: n.body || "",
        created_at: n.createdAt || "",
      });
    }

    hasNextPage = comments?.pageInfo?.hasNextPage ?? false;
    cursor = comments?.pageInfo?.endCursor || "";
  }

  return allComments;
}

/**
 * Updates an existing discussion comment body.
 */
export function updateDiscussionComment(
  commentId: string,
  body: string,
): void {
  const query = `
    mutation($commentId: ID!, $body: String!) {
      updateDiscussionComment(input: { commentId: $commentId, body: $body }) {
        comment { id }
      }
    }
  `;
  ghGraphqlData<{
    updateDiscussionComment?: { comment?: { id?: string } | null } | null;
  }>(query, { commentId, body });
}

/**
 * Fetches repository discussion settings and all visible discussion categories.
 */
export function fetchRepositoryDiscussionConfig(
  client: GraphQLClient,
  owner: string,
  repo: string,
): RepositoryDiscussionConfig {
  const query = `
    query($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        id
        hasDiscussionsEnabled
        discussionCategories(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id name }
        }
      }
    }
  `;

  const categories: DiscussionCategory[] = [];
  let repositoryId = "";
  let hasDiscussionsEnabled = false;
  let cursor = "";
  let hasNextPage = true;

  while (hasNextPage) {
    const variables: { owner: string; repo: string; cursor?: string } = { owner, repo };
    if (cursor) variables.cursor = cursor;

    const data = client.graphql<{
      repository?: {
        id?: string;
        hasDiscussionsEnabled?: boolean;
        discussionCategories?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
          nodes?: Array<{ id?: string; name?: string } | null> | null;
        } | null;
      } | null;
    }>(query, variables);

    const repository = data.repository;
    if (!repository?.id) {
      throw new Error(`Repository not found: ${owner}/${repo}`);
    }

    repositoryId = repository.id;
    hasDiscussionsEnabled = repository.hasDiscussionsEnabled ?? false;

    const page = repository.discussionCategories;
    for (const category of page?.nodes || []) {
      if (category?.id && category.name) {
        categories.push({ id: category.id, name: category.name });
      }
    }

    hasNextPage = page?.pageInfo?.hasNextPage ?? false;
    cursor = page?.pageInfo?.endCursor || "";
  }

  return { repositoryId, hasDiscussionsEnabled, categories };
}

export function requireDiscussionCategory(
  config: RepositoryDiscussionConfig,
  categoryName: string,
): DiscussionCategory {
  if (!config.hasDiscussionsEnabled) {
    throw new Error("Repository discussions are not enabled; cannot create a discussion.");
  }

  const category = config.categories.find((candidate) => candidate.name === categoryName);
  if (!category) {
    throw new Error(`Required discussion category '${categoryName}' was not found.`);
  }

  return category;
}

export function createDiscussion(
  client: GraphQLClient,
  repoId: string,
  categoryId: string,
  title: string,
  body: string,
): { url: string } {
  const query = `
    mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repoId,
        categoryId: $categoryId,
        title: $title,
        body: $body
      }) {
        discussion { url }
      }
    }
  `;

  const data = client.graphql<{
    createDiscussion?: { discussion?: { url?: string } | null } | null;
  }>(query, { repoId, categoryId, title, body });

  const url = data.createDiscussion?.discussion?.url;
  if (!url) {
    throw new Error("GitHub did not return a URL for the created discussion.");
  }
  return { url };
}

export function createRepositoryDiscussion(
  owner: string,
  repo: string,
  categoryName: string,
  title: string,
  body: string,
  client: GraphQLClient = createGhGraphqlClient(),
): { url: string } {
  const config = fetchRepositoryDiscussionConfig(client, owner, repo);
  const category = requireDiscussionCategory(config, categoryName);
  return createDiscussion(client, config.repositoryId, category.id, title, body);
}
