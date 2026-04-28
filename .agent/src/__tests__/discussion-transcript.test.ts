import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildDiscussionTranscript,
  fetchDiscussionTranscript,
  formatDiscussionTranscriptComment,
} from "../discussion-transcript.js";
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

test("buildDiscussionTranscript includes discussion metadata and nested replies", () => {
  const transcript = buildDiscussionTranscript(
    {
      id: "discussion-1",
      title: "Discussion title",
      url: "https://github.com/self-evolving/repo/discussions/1",
      author: "alice",
      body: "Discussion body",
    },
    [
      {
        id: "comment-1",
        author: "bob",
        createdAt: "2026-03-30T00:00:00Z",
        body: "Top-level comment",
        replyToId: "",
        replies: [
          {
            id: "reply-1",
            author: "carol",
            createdAt: "2026-03-30T01:00:00Z",
            body: "Thread reply",
            replyToId: "comment-1",
          },
        ],
      },
    ],
  );

  assert.match(transcript, /Title: Discussion title/);
  assert.match(transcript, /### Comment by bob/);
  assert.match(transcript, /#### Reply by carol/);
  assert.match(transcript, /Thread reply/);
});

test("buildDiscussionTranscript renders an empty comment section explicitly", () => {
  const transcript = buildDiscussionTranscript(
    {
      id: "discussion-2",
      title: "No comments yet",
      url: "https://github.com/self-evolving/repo/discussions/2",
      author: "alice",
      body: "Discussion body",
    },
    [],
  );

  assert.match(transcript, /## Comments/);
  assert.match(transcript, /_No comments yet\._/);
});

test("formatDiscussionTranscriptComment uses ghost fallback and reply headings", () => {
  const formatted = formatDiscussionTranscriptComment(
    {
      id: "reply-1",
      body: "Nested reply",
      createdAt: "",
      author: "",
      replyToId: "comment-1",
    },
    1,
  );

  assert.match(formatted, /#### Reply by ghost at /);
  assert.match(formatted, /Nested reply/);
});

test("fetchDiscussionTranscript paginates top-level comments and reply threads", async () => {
  const { client, calls } = createQueuedClient([
    {
      repository: {
        discussion: {
          id: "discussion-1",
          title: "Discussion title",
          url: "https://github.com/self-evolving/repo/discussions/1",
          body: "Discussion body",
          author: { login: "alice" },
          comments: {
            nodes: [
              {
                id: "comment-1",
                body: "First comment",
                createdAt: "2026-03-30T00:00:00Z",
                author: { login: "bob" },
                replyTo: null,
                replies: {
                  nodes: [
                    {
                      id: "reply-1",
                      body: "First reply",
                      createdAt: "2026-03-30T00:05:00Z",
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
              createdAt: "2026-03-30T00:10:00Z",
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
          id: "discussion-1",
          title: "Discussion title",
          url: "https://github.com/self-evolving/repo/discussions/1",
          body: "Discussion body",
          author: { login: "alice" },
          comments: {
            nodes: [
              {
                id: "comment-2",
                body: "Second comment",
                createdAt: "2026-03-30T01:00:00Z",
                author: { login: "erin" },
                replyTo: null,
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

  const result = await fetchDiscussionTranscript(
    client,
    "self-evolving",
    "repo",
    1,
  );

  assert.equal(result.discussionMeta.id, "discussion-1");
  assert.equal(result.comments.length, 2);
  assert.equal(result.comments[0].id, "comment-1");
  assert.equal(result.comments[0].replies.length, 2);
  assert.equal(result.comments[0].replies[1].id, "reply-2");
  assert.equal(result.comments[1].id, "comment-2");

  assert.equal(calls.length, 3);
  assert.equal(calls[0].variables.number, 1);
  assert.equal(calls[0].variables.after, undefined);
  assert.equal(calls[1].variables.commentId, "comment-1");
  assert.equal(calls[1].variables.after, "reply-cursor-1");
  assert.equal(calls[2].variables.after, "comment-cursor-1");
});

test("fetchDiscussionTranscript throws when the discussion cannot be found", () => {
  const { client } = createQueuedClient([
    {
      repository: {
        discussion: null,
      },
    },
  ]);

  let message = "";
  try {
    fetchDiscussionTranscript(client, "self-evolving", "repo", 404);
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.equal(message, "Discussion #404 not found");
});
