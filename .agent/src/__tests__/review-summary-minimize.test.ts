import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  collapsePreviousFixPrComments,
  collapsePreviousHandoffComments,
  collapsePreviousPrConversationArtifacts,
  collapsePreviousReviewSummaries,
  collapsePreviousRubricsReviews,
  isRubricsReviewBody,
} from "../review-summary-minimize.js";
import { isFixPrStatusBody } from "../fix-pr-status.js";
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

test("collapsePreviousReviewSummaries minimizes visible generated summaries", () => {
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                id: "comment-1",
                body: "## AI Review Synthesis\n\n<!-- sepo-agent-review-synthesis -->\nold",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
              {
                id: "comment-2",
                body: "## AI Review Synthesis\nalready collapsed",
                isMinimized: true,
                author: { login: "sepo-agent" },
              },
              {
                id: "comment-3",
                body: "## AI Review Synthesis\nother author",
                isMinimized: false,
                author: { login: "alice" },
              },
              {
                id: "comment-4",
                body: "Regular discussion",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      repository: {
        pullRequest: {
          reviews: {
            nodes: [
              {
                id: "review-1",
                body: "\n## AI Review Synthesis\nold review",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  const collapsed = collapsePreviousReviewSummaries({
    repo: "self-evolving/repo",
    prNumber: 320,
    client,
  });

  assert.equal(collapsed, 2);
  assert.equal(calls.length, 5);
  assert.match(calls[1]?.query || "", /comments/);
  assert.deepEqual(calls[1]?.variables, {
    owner: "self-evolving",
    name: "repo",
    number: 320,
    after: undefined,
  });
  assert.match(calls[2]?.query || "", /reviews/);
  assert.deepEqual(
    calls.slice(3).map((call) => call.variables),
    [
      { id: "comment-1", classifier: "OUTDATED" },
      { id: "review-1", classifier: "OUTDATED" },
    ],
  );
});

test("collapsePreviousReviewSummaries matches GitHub App bot login variants", () => {
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent-app[bot]" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                id: "comment-1",
                body: "## AI Review Synthesis\n\n<!-- sepo-agent-review-synthesis -->\nold",
                isMinimized: false,
                author: { login: "app/sepo-agent-app" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      repository: {
        pullRequest: {
          reviews: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  assert.equal(collapsePreviousReviewSummaries({
    repo: "self-evolving/repo",
    prNumber: 320,
    client,
  }), 1);
  assert.deepEqual(calls[3]?.variables, { id: "comment-1", classifier: "OUTDATED" });
});

test("collapsePreviousRubricsReviews minimizes rubrics reviews only", () => {
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                id: "comment-1",
                body: "preface\n\n## Rubrics Review\nold rubric scorecard",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
              {
                id: "comment-2",
                body: "## AI Review Synthesis\n\n<!-- sepo-agent-review-synthesis -->\nold synthesis",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
              {
                id: "comment-3",
                body: "## Rubrics Review\nother author",
                isMinimized: false,
                author: { login: "alice" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      repository: {
        pullRequest: {
          reviews: {
            nodes: [
              {
                id: "review-1",
                body: "## Rubrics Review\nold review body",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  const collapsed = collapsePreviousRubricsReviews({
    repo: "self-evolving/repo",
    prNumber: 320,
    client,
  });

  assert.equal(collapsed, 2);
  assert.deepEqual(
    calls.slice(3).map((call) => call.variables),
    [
      { id: "comment-1", classifier: "OUTDATED" },
      { id: "review-1", classifier: "OUTDATED" },
    ],
  );
});

test("collapsePreviousFixPrComments minimizes fix-pr status comments only", () => {
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                id: "comment-1",
                body: "**Sepo pushed fixes for this PR.** Branch: `agent/fix`.\n\n<!-- sepo-agent-fix-pr-status -->",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
              {
                id: "comment-2",
                body: "**Sepo did not produce code changes for this PR.**\n\nlegacy body",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
              {
                id: "comment-3",
                body: "## AI Review Synthesis\nnot a fix-pr status",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
              {
                id: "comment-4",
                body: "**Sepo pushed fixes for this PR.** other author",
                isMinimized: false,
                author: { login: "alice" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  const collapsed = collapsePreviousFixPrComments({
    repo: "self-evolving/repo",
    prNumber: 320,
    client,
  });

  assert.equal(collapsed, 2);
  assert.match(calls[1]?.query || "", /comments/);
  assert.doesNotMatch(calls[1]?.query || "", /reviews/);
  assert.deepEqual(
    calls.slice(2).map((call) => call.variables),
    [
      { id: "comment-1", classifier: "OUTDATED" },
      { id: "comment-2", classifier: "OUTDATED" },
    ],
  );
});

test("isFixPrStatusBody matches marker and legacy fix-pr status text", () => {
  assert.equal(isFixPrStatusBody("> Restored session\n\n<!-- sepo-agent-fix-pr-status -->"), true);
  assert.equal(isFixPrStatusBody("**Sepo could not update this PR automatically.**"), true);
  assert.equal(isFixPrStatusBody("**Sepo could not complete the PR fix run.**"), true);
  assert.equal(
    isFixPrStatusBody(
      "**Sepo made changes, but lightweight verification failed.**\n\n" +
      "Inspect the workflow logs before retrying the PR fix run.",
    ),
    true,
  );
  assert.equal(isFixPrStatusBody("**Sepo made changes, but lightweight verification failed.**"), false);
  assert.equal(isFixPrStatusBody("## AI Review Synthesis\nbody"), false);
});

test("collapsePreviousHandoffComments minimizes old issue handoff comments only", () => {
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent-app[bot]" } },
    {
      repository: {
        issue: {
          comments: {
            nodes: [
              {
                id: "old-handoff",
                body: "Sepo automation handoff dispatched\n\n<!-- sepo-agent-handoff state:dispatched created:123 base64:aGFuZG9m -->",
                isMinimized: false,
                author: { login: "sepo-agent-app" },
              },
              {
                id: "current-handoff",
                body: "Sepo automation handoff dispatched\n\n<!-- sepo-agent-handoff state:dispatched created:456 base64:Y3VycmVudA -->",
                isMinimized: false,
                author: { login: "sepo-agent-app" },
              },
              {
                id: "pending-handoff",
                body: "Sepo automation handoff pending\n\n<!-- sepo-agent-handoff state:pending created:100 base64:cGVuZGluZw -->",
                isMinimized: false,
                author: { login: "sepo-agent-app" },
              },
              {
                id: "newer-handoff",
                body: "Sepo automation handoff dispatched\n\n<!-- sepo-agent-handoff state:dispatched created:789 base64:bmV3ZXI -->",
                isMinimized: false,
                author: { login: "sepo-agent-app" },
              },
              {
                id: "other-body",
                body: "Regular discussion",
                isMinimized: false,
                author: { login: "sepo-agent-app" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  const collapsed = collapsePreviousHandoffComments({
    repo: "self-evolving/repo",
    targetNumber: 59,
    targetKind: "issue",
    excludeCommentId: "current-handoff",
    currentCreatedAtMs: 456,
    client,
  });

  assert.equal(collapsed, 1);
  assert.match(calls[1]?.query || "", /issue\(number: \$number\)/);
  assert.deepEqual(calls[2]?.variables, { id: "old-handoff", classifier: "OUTDATED" });
});

test("collapsePreviousHandoffComments uses pull request comments for PR targets", () => {
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                id: "old-handoff",
                body: "<!-- sepo-agent-handoff state:dispatched created:123 base64:aGFuZG9m -->",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
              {
                id: "current-handoff",
                body: "<!-- sepo-agent-handoff state:dispatched created:456 base64:Y3VycmVudA -->",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  assert.equal(collapsePreviousHandoffComments({
    repo: "self-evolving/repo",
    targetNumber: 57,
    targetKind: "pull_request",
    excludeCommentId: "current-handoff",
    currentCreatedAtMs: 456,
    client,
  }), 1);
  assert.match(calls[1]?.query || "", /pullRequest\(number: \$number\)/);
  assert.deepEqual(calls[2]?.variables, { id: "old-handoff", classifier: "OUTDATED" });
});

test("rubrics body detection matches heading after a continuity note", () => {
  assert.equal(isRubricsReviewBody("> Restored session\n\n## Rubrics Review\nbody"), true);
  assert.equal(isRubricsReviewBody("## AI Review Synthesis\nbody"), false);
});

test("collapsePreviousReviewSummaries keeps heading fallback for markerless summaries", () => {
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                id: "comment-1",
                body: "## AI Review Synthesis\nold markerless comment",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      repository: {
        pullRequest: {
          reviews: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  assert.equal(collapsePreviousReviewSummaries({
    repo: "self-evolving/repo",
    prNumber: 320,
    client,
  }), 1);
  assert.deepEqual(calls[3]?.variables, { id: "comment-1", classifier: "OUTDATED" });
});

test("collapsePreviousReviewSummaries paginates comments", () => {
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      },
    },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                id: "comment-1",
                body: "## AI Review Synthesis\nold",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      repository: {
        pullRequest: {
          reviews: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  assert.equal(collapsePreviousReviewSummaries({
    repo: "self-evolving/repo",
    prNumber: 320,
    client,
  }), 1);
  assert.equal(calls[1]?.variables.after, undefined);
  assert.equal(calls[2]?.variables.after, "cursor-1");
});

test("terminal cleanup stops at the causal source artifact", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const generated = (id: string, databaseId: number, body: string) => ({
    id,
    databaseId,
    body,
    isMinimized: false,
    author: { login: "sepo-agent" },
  });
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              generated("older-final", 100, "<!-- sepo-agent-orchestrate-stop -->"),
              generated("source-review", 101, `## AI Review Synthesis\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: ${head} -->\nsource`),
              generated("later-review", 102, "## AI Review Synthesis\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->\nlater overlapping run"),
              generated("current-final", 103, "<!-- sepo-agent-orchestrate-stop -->\n<!-- sepo-agent-orchestration-source-artifact: 101 -->"),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  assert.deepEqual(collapsePreviousPrConversationArtifacts({
    repo: "self-evolving/repo",
    prNumber: 320,
    currentFinalCommentDatabaseId: "103",
    excludeBodyMarker: "<!-- sepo-agent-orchestrate-stop -->",
    expectedHeadSha: head,
    sourceArtifactDatabaseId: "101",
    client,
  }), { collapsed: 2 });
  assert.deepEqual(
    calls.slice(2).map((call) => call.variables),
    [
      { id: "older-final", classifier: "OUTDATED" },
      { id: "source-review", classifier: "OUTDATED" },
    ],
  );
});

test("terminal cleanup fails closed without a safe source artifact boundary", () => {
  const { client, calls } = createQueuedClient([]);

  assert.deepEqual(collapsePreviousPrConversationArtifacts({
    repo: "self-evolving/repo",
    prNumber: 320,
    currentFinalCommentDatabaseId: "102",
    expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceArtifactDatabaseId: "not-a-database-id",
    client,
  }), {
    collapsed: 0,
    skippedReason: "source artifact database ID is missing or invalid",
  });
  assert.equal(calls.length, 0);
});

test("terminal cleanup rejects a boundary that points to the wrong artifact type", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              {
                id: "older-review",
                databaseId: 100,
                body: `## AI Review Synthesis\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: ${head} -->\nolder`,
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
              {
                id: "wrong-source-type",
                databaseId: 101,
                body: "## Rubrics Review\nnot a synthesis",
                isMinimized: false,
                author: { login: "sepo-agent" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ]);

  assert.deepEqual(collapsePreviousPrConversationArtifacts({
    repo: "self-evolving/repo",
    prNumber: 320,
    currentFinalCommentDatabaseId: "102",
    expectedHeadSha: head,
    sourceArtifactDatabaseId: "101",
    client,
  }), {
    collapsed: 0,
    skippedReason: "source artifact is not the latest trusted review synthesis for the expected head",
  });
  assert.equal(calls.length, 2);
});

test("terminal cleanup converges same-source reruns without hiding unrelated later artifacts", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sourceMarker = "<!-- sepo-agent-orchestration-source-artifact: 101 -->";
  const generated = (
    id: string,
    databaseId: number,
    body: string,
    isMinimized = false,
  ) => ({
    id,
    databaseId,
    body,
    isMinimized,
    author: { login: "sepo-agent" },
  });
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [
              generated("older-status", 100, "<!-- sepo-agent-fix-pr-status -->"),
              generated(
                "source-review",
                101,
                `## AI Review Synthesis\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: ${head} -->`,
                true,
              ),
              generated("old-final", 102, `<!-- sepo-agent-orchestrate-stop -->\n${sourceMarker}`),
              generated("old-handoff", 103, `<!-- sepo-agent-handoff state:dispatched created:123 base64:aGFuZG9m -->\n${sourceMarker}`),
              generated("unrelated-final", 104, "<!-- sepo-agent-orchestrate-stop -->"),
              generated("current-final", 105, `<!-- sepo-agent-orchestrate-stop -->\n${sourceMarker}`),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
    { minimizeComment: { minimizedComment: { isMinimized: true } } },
  ]);

  assert.deepEqual(collapsePreviousPrConversationArtifacts({
    repo: "self-evolving/repo",
    prNumber: 320,
    currentFinalCommentDatabaseId: "105",
    excludeBodyMarker: "<!-- sepo-agent-orchestrate-stop -->",
    expectedHeadSha: head,
    sourceArtifactDatabaseId: "101",
    client,
  }), { collapsed: 3 });
  assert.deepEqual(calls.slice(2).map((call) => call.variables.id), [
    "older-status",
    "old-final",
    "old-handoff",
  ]);
});

test("terminal cleanup rejects a superseded same-head source synthesis", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const generated = (id: string, databaseId: number, verdict: string) => ({
    id,
    databaseId,
    body: `## AI Review Synthesis\n<!-- sepo-agent-review-synthesis -->\n<!-- sepo-agent-review-synthesis-head: ${head} -->\nVerdict: ${verdict}`,
    isMinimized: false,
    author: { login: "sepo-agent" },
  });
  const { client, calls } = createQueuedClient([
    { viewer: { login: "sepo-agent" } },
    {
      repository: {
        pullRequest: {
          comments: {
            nodes: [generated("source", 101, "SHIP"), generated("newer", 102, "NEEDS_REWORK")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ]);

  assert.deepEqual(collapsePreviousPrConversationArtifacts({
    repo: "self-evolving/repo",
    prNumber: 320,
    currentFinalCommentDatabaseId: "103",
    expectedHeadSha: head,
    sourceArtifactDatabaseId: "101",
    client,
  }), {
    collapsed: 0,
    skippedReason: "source artifact is not the latest trusted review synthesis for the expected head",
  });
  assert.equal(calls.length, 2);
});
