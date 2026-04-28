import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildGhApiPagedArgs,
  fetchDiscussionDetail,
  fetchDiscussions,
} from "../cli/memory/sync-github-artifacts.js";
import type { GraphQLClient, GraphQLVariableValue } from "../github-graphql.js";

function createQueuedClient(responses: unknown[]): {
  client: GraphQLClient;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
} {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const client: GraphQLClient = {
    graphql<T>(
      query: string,
      variables: Record<string, GraphQLVariableValue>,
    ): T {
      calls.push({ query, variables: { ...variables } });
      if (responses.length === 0) {
        throw new Error("Unexpected GraphQL call");
      }
      return responses.shift() as T;
    },
  };

  return { client, calls };
}

test("buildGhApiPagedArgs forces GET for REST list parameters", () => {
  assert.deepEqual(
    buildGhApiPagedArgs("repos/self-evolving/repo/issues", [
      ["-f", "state=all"],
      ["-F", "per_page=100"],
    ]),
    [
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      "repos/self-evolving/repo/issues",
      "-f",
      "state=all",
      "-F",
      "per_page=100",
    ],
  );
});

test("fetchDiscussions skips listing when repository discussions are disabled", () => {
  const { client, calls } = createQueuedClient([
    {
      repository: {
        hasDiscussionsEnabled: false,
      },
    },
  ]);

  const discussions = fetchDiscussions(
    client,
    "self-evolving",
    "repo",
    "2026-04-20T00:00:00Z",
  );

  assert.deepEqual(discussions, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.query || "", /hasDiscussionsEnabled/);
});

test("fetchDiscussionDetail paginates top-level comments and nested replies", () => {
  const { client, calls } = createQueuedClient([
    {
      repository: {
        discussion: {
          number: 7,
          title: "Discussion title",
          url: "https://github.com/self-evolving/repo/discussions/7",
          body: "Discussion body",
          createdAt: "2026-04-20T00:00:00Z",
          updatedAt: "2026-04-21T00:00:00Z",
          author: { login: "alice" },
          category: { name: "Ideas" },
          comments: {
            nodes: [
              {
                id: "comment-1",
                body: "First comment",
                createdAt: "2026-04-20T01:00:00Z",
                url: "https://github.com/self-evolving/repo/discussions/7#discussioncomment-1",
                author: { login: "bob" },
                replies: {
                  nodes: [
                    {
                      id: "reply-1",
                      body: "First reply",
                      createdAt: "2026-04-20T01:05:00Z",
                      url: "https://github.com/self-evolving/repo/discussions/7#discussioncomment-2",
                      author: { login: "carol" },
                      replyTo: { id: "comment-1" },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: "reply-cursor-1",
                  },
                },
              },
            ],
            pageInfo: {
              hasNextPage: true,
              endCursor: "comment-cursor-1",
            },
          },
        },
      },
    },
    {
      node: {
        replies: {
          nodes: [
            {
              id: "reply-2",
              body: "Second reply",
              createdAt: "2026-04-20T01:10:00Z",
              url: "https://github.com/self-evolving/repo/discussions/7#discussioncomment-3",
              author: { login: "dave" },
              replyTo: { id: "comment-1" },
            },
          ],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    },
    {
      repository: {
        discussion: {
          number: 7,
          title: "Discussion title",
          url: "https://github.com/self-evolving/repo/discussions/7",
          body: "Discussion body",
          createdAt: "2026-04-20T00:00:00Z",
          updatedAt: "2026-04-21T00:00:00Z",
          author: { login: "alice" },
          category: { name: "Ideas" },
          comments: {
            nodes: [
              {
                id: "comment-2",
                body: "Second comment",
                createdAt: "2026-04-20T02:00:00Z",
                url: "https://github.com/self-evolving/repo/discussions/7#discussioncomment-4",
                author: { login: "erin" },
                replies: {
                  nodes: [],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      },
    },
  ]);

  const detail = fetchDiscussionDetail(client, "self-evolving", "repo", 7) as {
    number: number;
    comments: {
      nodes: Array<{
        id: string;
        replies: {
          nodes: Array<{ id: string }>;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: null };
    };
  };

  assert.equal(detail.number, 7);
  assert.equal(detail.comments.nodes.length, 2);
  assert.equal(detail.comments.nodes[0]?.id, "comment-1");
  assert.equal(detail.comments.nodes[0]?.replies.nodes.length, 2);
  assert.equal(detail.comments.nodes[0]?.replies.nodes[1]?.id, "reply-2");
  assert.equal(detail.comments.nodes[1]?.id, "comment-2");
  assert.deepEqual(detail.comments.pageInfo, {
    hasNextPage: false,
    endCursor: null,
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.variables.n, 7);
  assert.equal(calls[0]?.variables.after, undefined);
  assert.equal(calls[1]?.variables.commentId, "comment-1");
  assert.equal(calls[1]?.variables.after, "reply-cursor-1");
  assert.equal(calls[2]?.variables.after, "comment-cursor-1");
});
