import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  extractEventContext,
  getAuthorAssociation,
  getRequestedBy,
  shouldSkipSender,
  shouldRespondToMention,
} from "../context.js";

test("extractEventContext maps PR review comments to thread replies", () => {
  const ctx = extractEventContext("pull_request_review_comment", {
    comment: {
      id: 42,
      body: "fix the bug",
      html_url: "https://github.com/org/repo/pull/5#discussion_r42",
      node_id: "PRRC_42",
      user: { login: "alice" },
    },
    pull_request: {
      number: 5,
      html_url: "https://github.com/org/repo/pull/5",
    },
  });
  assert.equal(ctx.sourceKind, "pull_request_review_comment");
  assert.equal(ctx.targetKind, "pull_request");
  assert.equal(ctx.targetNumber, "5");
  assert.equal(ctx.responseKind, "review_comment_reply");
  assert.equal(ctx.reviewCommentId, "42");
  assert.equal(ctx.reactionSubjectId, "PRRC_42");
});

test("extractEventContext captures triggering PR issue comments", () => {
  const ctx = extractEventContext("issue_comment", {
    comment: {
      id: 99,
      body: "please review",
      html_url: "https://github.com/org/repo/issues/3#issuecomment-99",
      node_id: "IC_99",
    },
    issue: {
      number: 3,
      html_url: "https://github.com/org/repo/issues/3",
      pull_request: { url: "https://api.github.com/repos/org/repo/pulls/3" },
    },
  });
  assert.equal(ctx.targetKind, "pull_request");
  assert.equal(ctx.sourceKind, "issue_comment");
  assert.equal(ctx.sourceCommentId, "99");
});

test("extractEventContext captures triggering PR reviews", () => {
  const ctx = extractEventContext("pull_request_review", {
    review: {
      id: 77,
      body: "looks good",
      html_url: "https://github.com/org/repo/pull/5#pullrequestreview-77",
      node_id: "PRR_77",
      user: { login: "bob" },
    },
    pull_request: {
      number: 5,
      html_url: "https://github.com/org/repo/pull/5",
    },
  });
  assert.equal(ctx.sourceKind, "pull_request_review");
  assert.equal(ctx.targetKind, "pull_request");
  assert.equal(ctx.reactionSubjectId, "PRR_77");
});

test("extractEventContext maps discussion comments to discussion replies", () => {
  const ctx = extractEventContext("discussion_comment", {
    comment: {
      body: "interesting point",
      node_id: "DC_10",
    },
    discussion: {
      number: 1,
      html_url: "https://github.com/org/repo/discussions/1",
      node_id: "D_1",
    },
  });
  assert.equal(ctx.targetKind, "discussion");
  assert.equal(ctx.responseKind, "discussion_comment");
  assert.equal(ctx.discussionNodeId, "D_1");
  assert.equal(ctx.discussionCommentNodeId, "DC_10");
});

test("extractEventContext extracts discussionNodeId for discussion body mentions", () => {
  const ctx = extractEventContext("discussion", {
    discussion: {
      title: "Design",
      body: "content",
      number: 1,
      html_url: "https://github.com/org/repo/discussions/1",
      node_id: "D_1",
    },
  });
  assert.equal(ctx.targetKind, "discussion");
  assert.equal(ctx.discussionNodeId, "D_1");
  assert.ok(ctx.body.includes("Design"));
});

test("getAuthorAssociation reads discussion associations", () => {
  assert.equal(
    getAuthorAssociation("discussion", {
      discussion: { authorAssociation: "MEMBER" },
    }),
    "MEMBER",
  );
  assert.equal(
    getAuthorAssociation("discussion_comment", {
      comment: { author_association: "COLLABORATOR" },
    }),
    "COLLABORATOR",
  );
});

test("getRequestedBy extracts login from various event types", () => {
  assert.equal(
    getRequestedBy("issue_comment", { comment: { user: { login: "alice" } } }),
    "alice",
  );
  assert.equal(
    getRequestedBy("pull_request_review", { review: { user: { login: "bob" } } }),
    "bob",
  );
  assert.equal(
    getRequestedBy("discussion", { discussion: { user: { login: "carol" } } }),
    "carol",
  );
});

test("extractEventContext handles pull_request_target same as pull_request", () => {
  const payload = {
    pull_request: {
      number: 7,
      title: "feat: label triggers",
      body: "Add label-based activation",
      html_url: "https://github.com/org/repo/pull/7",
      node_id: "PR_7",
      author_association: "MEMBER",
      user: { login: "alice" },
    },
  };
  const ctx = extractEventContext("pull_request_target", payload);
  assert.equal(ctx.sourceKind, "pull_request");
  assert.equal(ctx.targetKind, "pull_request");
  assert.equal(ctx.targetNumber, "7");
  assert.equal(ctx.reactionSubjectId, "PR_7");
  assert.ok(ctx.body.includes("label triggers"));

  assert.equal(getAuthorAssociation("pull_request_target", payload), "MEMBER");
  assert.equal(getRequestedBy("pull_request_target", payload), "alice");
});

test("shouldRespondToMention only triggers when an issue edit adds a mention", () => {
  assert.equal(
    shouldRespondToMention(
      "issues",
      {
        action: "edited",
        issue: {
          title: "Need @sepo-agent",
          body: "body",
        },
        changes: {
          title: {
            from: "Need help",
          },
        },
      },
      "@sepo-agent",
    ),
    true,
  );

  assert.equal(
    shouldRespondToMention(
      "issues",
      {
        action: "edited",
        issue: {
          title: "Need @sepo-agent",
          body: "updated body",
        },
        changes: {
          body: {
            from: "body",
          },
        },
      },
      "@sepo-agent",
    ),
    false,
  );
});

test("shouldRespondToMention only triggers when an edited comment adds a mention", () => {
  assert.equal(
    shouldRespondToMention(
      "issue_comment",
      {
        action: "edited",
        comment: {
          body: "please check @sepo-agent",
        },
        changes: {
          body: {
            from: "please check",
          },
        },
      },
      "@sepo-agent",
    ),
    true,
  );

  assert.equal(
    shouldRespondToMention(
      "issue_comment",
      {
        action: "edited",
        comment: {
          body: "please check @sepo-agent again",
        },
        changes: {
          body: {
            from: "please check @sepo-agent",
          },
        },
      },
      "@sepo-agent",
    ),
    false,
  );

  assert.equal(
    shouldRespondToMention(
      "pull_request_review_comment",
      {
        action: "edited",
        comment: {
          body: "please check @sepo-agent",
        },
        changes: {
          body: {
            from: "please check",
          },
        },
      },
      "@sepo-agent",
    ),
    true,
  );
});

test("shouldSkipSender filters bots", () => {
  assert.ok(shouldSkipSender({ sender: { type: "Bot", login: "dependabot[bot]" } }));
  assert.ok(shouldSkipSender({ sender: { type: "User", login: "github-actions" } }));
  assert.ok(!shouldSkipSender({ sender: { type: "User", login: "alice" } }));
});
