import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  createDiscussion,
  createRepositoryDiscussion,
  fetchRepositoryDiscussionConfig,
  requireDiscussionCategory,
} from "../discussion.js";
import type { GraphQLClient, GraphQLVariableValue } from "../github-graphql.js";

function queuedClient(responses: unknown[]): {
  client: GraphQLClient;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
} {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client: GraphQLClient = {
    graphql<T>(query: string, variables: Record<string, GraphQLVariableValue>): T {
      calls.push({ query, variables: { ...variables } });
      if (responses.length === 0) throw new Error("Unexpected GraphQL call");
      return responses.shift() as T;
    },
  };
  return { client, calls };
}

test("fetchRepositoryDiscussionConfig paginates categories", () => {
  const { client, calls } = queuedClient([
    {
      repository: {
        id: "repo-1",
        hasDiscussionsEnabled: true,
        discussionCategories: {
          nodes: [{ id: "cat-1", name: "General" }],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    },
    {
      repository: {
        id: "repo-1",
        hasDiscussionsEnabled: true,
        discussionCategories: {
          nodes: [{ id: "cat-2", name: "Daily Summaries" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ]);

  const config = fetchRepositoryDiscussionConfig(client, "self-evolving", "repo");

  assert.equal(config.repositoryId, "repo-1");
  assert.equal(config.hasDiscussionsEnabled, true);
  assert.deepEqual(config.categories, [
    { id: "cat-1", name: "General" },
    { id: "cat-2", name: "Daily Summaries" },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.variables.cursor, undefined);
  assert.equal(calls[1]?.variables.cursor, "cursor-1");
});

test("requireDiscussionCategory validates discussion configuration", () => {
  assert.throws(
    () => requireDiscussionCategory({
      repositoryId: "repo-1",
      hasDiscussionsEnabled: false,
      categories: [],
    }, "Daily Summaries"),
    /discussions are not enabled/,
  );

  assert.throws(
    () => requireDiscussionCategory({
      repositoryId: "repo-1",
      hasDiscussionsEnabled: true,
      categories: [{ id: "cat-1", name: "General" }],
    }, "Daily Summaries"),
    /Required discussion category 'Daily Summaries' was not found/,
  );
});

test("createDiscussion returns the created discussion URL", () => {
  const { client, calls } = queuedClient([
    { createDiscussion: { discussion: { url: "https://github.com/org/repo/discussions/1" } } },
  ]);

  const discussion = createDiscussion(client, "repo-1", "cat-1", "Daily Summary", "Body");

  assert.equal(discussion.url, "https://github.com/org/repo/discussions/1");
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.query || "", /createDiscussion/);
});

test("createRepositoryDiscussion composes config lookup and creation", () => {
  const { client, calls } = queuedClient([
    {
      repository: {
        id: "repo-1",
        hasDiscussionsEnabled: true,
        discussionCategories: {
          nodes: [{ id: "cat-1", name: "Daily Summaries" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
    { createDiscussion: { discussion: { url: "https://github.com/org/repo/discussions/2" } } },
  ]);

  const discussion = createRepositoryDiscussion(
    "org",
    "repo",
    "Daily Summaries",
    "Daily Summary",
    "Body",
    client,
  );

  assert.equal(discussion.url, "https://github.com/org/repo/discussions/2");
  assert.equal(calls.length, 2);
});
