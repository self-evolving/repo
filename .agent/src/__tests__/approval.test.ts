import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildApprovalRequestMarker,
  findPendingRequestById,
  parseApprovalRequestMarker,
  parseApprovalCommand,
  isApprovalRequestAlreadySatisfied,
  markApprovalRequestSatisfied,
  isApprovalCommand,
  isAgentApprovalComment,
  shouldCreateIssueFromApprovalRequest,
} from "../approval.js";

test("approval marker round-trips through build and parse", () => {
  const data = { route: "implement", target_kind: "issue", target_number: 42 };
  const marker = buildApprovalRequestMarker(data);
  const parsed = parseApprovalRequestMarker(marker);
  assert.deepEqual(parsed, data);
});

test("approval marker round-trips with request_text", () => {
  const data = {
    route: "implement",
    request_text: "please implement this feature",
    target_kind: "issue",
    target_number: 42,
  };
  const marker = buildApprovalRequestMarker(data);
  const parsed = parseApprovalRequestMarker(marker);
  assert.equal(parsed?.request_text, "please implement this feature");
});

test("approval marker hides raw request text that contains HTML comment terminators", () => {
  const data = {
    route: "implement",
    request_text: "do this --> and keep -- dangerous sequences hidden",
    target_kind: "issue",
    target_number: 42,
  };
  const marker = buildApprovalRequestMarker(data);
  const parsed = parseApprovalRequestMarker(marker);

  assert.ok(marker.startsWith("<!-- sepo-agent-request base64:"));
  assert.doesNotMatch(marker, /do this/);
  assert.equal(marker.match(/-->/g)?.length, 1);
  assert.equal(
    parsed?.request_text,
    "do this --> and keep -- dangerous sequences hidden",
  );
});

test("parseApprovalRequestMarker returns null for corrupted encoded markers", () => {
  assert.equal(
    parseApprovalRequestMarker("<!-- sepo-agent-request base64:not-valid*** -->"),
    null,
  );
  assert.equal(
    parseApprovalRequestMarker(
      "<!-- sepo-agent-request base64:bm90LWpzb24 -->",
    ),
    null,
  );
});

test("parseApprovalRequestMarker returns null for non-marker content", () => {
  assert.equal(parseApprovalRequestMarker("just a regular comment"), null);
  assert.equal(parseApprovalRequestMarker(""), null);
  assert.equal(
    parseApprovalRequestMarker(
      '<!-- sepo-agent-request {"route":"implement","request_text":"legacy"} -->',
    ),
    null,
  );
});

test("isApprovalCommand accepts only explicit mention slash-approve commands with ids", () => {
  assert.ok(isApprovalCommand("@sepo-agent /approve req-a1b2c3"));
  assert.ok(!isApprovalCommand("/approve req-a1b2c3"));
  assert.ok(!isApprovalCommand("@sepo-agent approve req-a1b2c3"));
  assert.ok(!isApprovalCommand("Sure, @sepo-agent /approve this"));
  assert.ok(!isApprovalCommand("@sepo-agent review"));
  assert.ok(!isApprovalCommand("just a comment"));
});

test("parseApprovalCommand extracts the request id", () => {
  assert.deepEqual(parseApprovalCommand("@sepo-agent /approve req-a1b2c3"), {
    requestId: "req-a1b2c3",
  });
  assert.equal(parseApprovalCommand("@sepo-agent approve req-a1b2c3"), null);
  assert.equal(parseApprovalCommand("@sepo-agent /approve"), null);
});

test("approval commands accept a configured mention", () => {
  const mention = "@custom/agent";
  assert.ok(isApprovalCommand("@custom/agent /approve req-a1b2c3", mention));
  assert.deepEqual(parseApprovalCommand("@custom/agent /approve req-a1b2c3", mention), {
    requestId: "req-a1b2c3",
  });
  assert.equal(isApprovalCommand("@sepo-agent /approve req-a1b2c3", mention), false);
});

test("approval commands ignore fenced code blocks and quotes", () => {
  const body = [
    "Example:",
    "",
    "```text",
    "@sepo-agent /approve req-a1b2c3",
    "```",
    "",
    "> @sepo-agent /approve req-z9y8x7",
  ].join("\n");

  assert.equal(isApprovalCommand(body), false);
  assert.equal(parseApprovalCommand(body), null);
});

test("isApprovalRequestAlreadySatisfied detects the marker", () => {
  assert.ok(!isApprovalRequestAlreadySatisfied("pending request"));
  assert.ok(
    isApprovalRequestAlreadySatisfied("body\n\n<!-- sepo-agent-approved -->"),
  );
});

test("findPendingRequestById skips approved requests and matches exact ids", () => {
  const marker = buildApprovalRequestMarker({ route: "implement", request_id: "req-old" });
  const comments = [
    {
      id: "1",
      body: `Request.\n\n${marker}\n\n<!-- sepo-agent-approved -->`,
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "2",
      body: `Another.\n\n${buildApprovalRequestMarker({ route: "review", request_id: "req-new" })}`,
      created_at: "2026-01-02T00:00:00Z",
    },
  ];
  const result = findPendingRequestById(comments, "req-new");
  assert.ok(result);
  assert.equal(result!.comment.id, "2");
  assert.equal(result!.request.route, "review");
});

test("findPendingRequestById returns null when all matching ids are satisfied", () => {
  const marker = buildApprovalRequestMarker({ route: "implement", request_id: "req-a1b2c3" });
  const comments = [
    {
      id: "1",
      body: `${marker}\n\n<!-- sepo-agent-approved -->`,
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  assert.equal(findPendingRequestById(comments, "req-a1b2c3"), null);
});

test("findPendingRequestById returns null for empty list", () => {
  assert.equal(findPendingRequestById([], "req-a1b2c3"), null);
});

test("isAgentApprovalComment detects request and satisfied markers", () => {
  const requestMarker = buildApprovalRequestMarker({ route: "implement", request_id: "req-a1b2c3" });
  assert.ok(isAgentApprovalComment(requestMarker));
  assert.ok(isAgentApprovalComment("body\n\n<!-- sepo-agent-approved -->"));
  assert.equal(isAgentApprovalComment("just a human approval reply"), false);
});

test("markApprovalRequestSatisfied renders table with full context", () => {
  const body = markApprovalRequestSatisfied("original body", "alice", {
    route: "implement",
    workflow: "agent-implement.yml",
    issueUrl: "https://github.com/org/repo/issues/42",
    runUrl: "https://github.com/org/repo/actions/runs/123",
  });
  assert.match(body, /@alice/);
  assert.match(body, /implement/);
  assert.match(body, /#42/);
  assert.match(body, /approval run/);
  assert.match(body, /sepo-agent-approved/);
});

test("markApprovalRequestSatisfied renders table without extra context", () => {
  const body = markApprovalRequestSatisfied("body", "bob");
  assert.match(body, /@bob/);
  assert.match(body, /\u2014/); // em dash for missing tracking
  assert.match(body, /sepo-agent-approved/);
});

test("shouldCreateIssueFromApprovalRequest only for non-issue implementation-like routes", () => {
  assert.ok(
    shouldCreateIssueFromApprovalRequest({
      route: "implement",
      target_kind: "discussion",
      issue_title: "feat: add X",
    }),
  );
  assert.ok(
    shouldCreateIssueFromApprovalRequest({
      route: "create-action",
      target_kind: "discussion",
      issue_title: "Create scheduled action",
    }),
  );
  assert.ok(
    !shouldCreateIssueFromApprovalRequest({
      route: "implement",
      target_kind: "issue",
      issue_title: "feat: add X",
    }),
  );
  assert.ok(
    !shouldCreateIssueFromApprovalRequest({
      route: "review",
      target_kind: "pull_request",
      issue_title: "",
    }),
  );
  assert.ok(
    !shouldCreateIssueFromApprovalRequest({
      route: "implement",
      target_kind: "discussion",
      issue_title: "",
    }),
  );
});
