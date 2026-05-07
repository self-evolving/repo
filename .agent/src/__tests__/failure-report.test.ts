import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildFailureReport,
  classifyFailure,
  publishApprovedFailureReport,
  publishFailureReport,
  resolveFailureReportMode,
  sanitizeFailureEvidence,
} from "../failure-report.js";
import type { GraphQLClient, GraphQLVariableValue } from "../github-graphql.js";

function source() {
  return {
    repo: "self-evolving/repo",
    route: "implement",
    workflow: "agent-implement.yml",
    targetKind: "issue",
    targetNumber: "156",
    targetUrl: "https://github.com/self-evolving/repo/issues/156",
    sourceKind: "workflow_dispatch",
    requestedBy: "lolipopshock",
    runUrl: "https://github.com/self-evolving/repo/actions/runs/123",
    runId: "123",
    runAttempt: "1",
    sha: "abc1234",
  };
}

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

test("resolveFailureReportMode defaults public repos to approval and private repos to diagnose", () => {
  assert.equal(resolveFailureReportMode("", false), "approval");
  assert.equal(resolveFailureReportMode("", true), "diagnose");
  assert.equal(resolveFailureReportMode("auto", false), "approval");
  assert.equal(resolveFailureReportMode("false", false), "false");
  assert.equal(resolveFailureReportMode("diagnose", false), "diagnose");
  assert.equal(resolveFailureReportMode("approval", true), "approval");
  assert.equal(resolveFailureReportMode("true", true), "true");
  assert.throws(() => resolveFailureReportMode("blind-post", false), /Invalid AGENT_FAILURE_REPORT_MODE/);
});

test("classifyFailure separates auth failures from product bug candidates", () => {
  assert.equal(
    classifyFailure("", "Error: Resource not accessible by integration").category,
    "setup_or_auth",
  );

  const productBug = classifyFailure(
    "",
    "TypeError: Cannot read properties of undefined\n    at main (.agent/dist/run.js:10:2)",
  );
  assert.equal(productBug.category, "agent_product_bug_candidate");
  assert.equal(productBug.productBugLikelihood, "high");

  const genericUserError = classifyFailure(
    "",
    "TypeError: Cannot read properties of undefined\n    at main (scripts/build.js:10:2)",
  );
  assert.notEqual(genericUserError.category, "agent_product_bug_candidate");
  assert.notEqual(genericUserError.productBugLikelihood, "high");

  const providerAdapterError = classifyFailure(
    "",
    [
      "OpenAI API error 429: rate limit exceeded",
      "    at requestOpenAI (.agent/dist/acpx-adapter.js:10:2)",
    ].join("\n"),
  );
  assert.equal(providerAdapterError.category, "provider_or_runtime");
  assert.equal(providerAdapterError.productBugLikelihood, "low");
});

test("buildFailureReport redacts evidence and creates a pending report draft", () => {
  const report = buildFailureReport({
    mode: "approval",
    exitCode: "1",
    rawStdout: "stdout with github_pat_123456789012345678901234567890",
    rawStderr: "TypeError: exploded\n    at run (.agent/src/run.ts:1:1)",
    reportRepository: "self-evolving/repo",
    discussionCategory: "Bug Report",
    source: source(),
    now: new Date("2026-05-05T00:00:00.000Z"),
  });

  assert.equal(report.diagnosis.category, "agent_product_bug_candidate");
  assert.equal(report.diagnosis.reportable, true);
  assert.match(report.diagnosis.fingerprint, /^[a-f0-9]{24}$/);
  assert.doesNotMatch(report.pendingReportBody, /github_pat_/);
  assert.match(report.pendingReportBody, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.equal(report.diagnosis.proposedDiscussion.category, "Bug Report");
  assert.match(report.stepSummary, /Agent Failure Diagnosis/);
});

test("buildFailureReport surfaces unpublishable pending destination warnings", () => {
  const report = buildFailureReport({
    mode: "approval",
    exitCode: "1",
    rawStdout: "",
    rawStderr: "TypeError: exploded\n    at run (.agent/src/run.ts:1:1)",
    reportRepository: "not-a-repo-slug",
    discussionCategory: "Bug Report",
    source: source(),
    now: new Date("2026-05-05T00:00:00.000Z"),
  });

  assert.equal(report.diagnosis.proposedDiscussion.publishable, false);
  assert.equal(report.diagnosis.proposedDiscussion.shouldPublish, false);
  assert.match(report.diagnosis.proposedDiscussion.warning, /owner\/repo/);
  assert.match(report.stepSummary, /not publishable/);
  assert.match(report.pendingReportBody, /unpublishable preview/);
});

test("sanitizeFailureEvidence redacts common token shapes", () => {
  const sanitized = sanitizeFailureEvidence(
    [
      "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456 token=sk-abcdefghijklmnopqrstuvwxyz123456",
      "AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join("\n"),
  );
  assert.doesNotMatch(sanitized, /ghp_/);
  assert.doesNotMatch(sanitized, /sk-/);
  assert.doesNotMatch(sanitized, /AKIA/);
  assert.doesNotMatch(sanitized, /eyJ/);
  assert.match(sanitized, /\[REDACTED_AWS_ACCESS_KEY\]/);
  assert.match(sanitized, /\[REDACTED_JWT\]/);
  assert.match(sanitized, /\[REDACTED\]/);
});

test("publishFailureReport creates discussions only in explicit true mode for reportable failures", () => {
  const report = buildFailureReport({
    mode: "true",
    exitCode: "1",
    rawStdout: "",
    rawStderr: "TypeError: exploded\n    at run (.agent/dist/run.js:1:1)",
    reportRepository: "self-evolving/repo",
    discussionCategory: "Bug Report",
    source: source(),
    now: new Date("2026-05-05T00:00:00.000Z"),
  });
  const { client, calls } = queuedClient([
    { repository: { discussions: { nodes: [] } } },
    {
      repository: {
        id: "repo-1",
        hasDiscussionsEnabled: true,
        discussionCategories: {
          nodes: [{ id: "cat-1", name: "Bug Report" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
    { createDiscussion: { discussion: { url: "https://github.com/self-evolving/repo/discussions/1" } } },
  ]);

  const publication = publishFailureReport(report.diagnosis, client);

  assert.equal(publication.status, "created");
  assert.equal(publication.url, "https://github.com/self-evolving/repo/discussions/1");
  assert.equal(calls.length, 3);
  assert.match(calls[0]?.query || "", /discussions/);
  assert.match(calls[2]?.query || "", /createDiscussion/);
});

test("publishFailureReport makes zero GraphQL calls in approval mode", () => {
  const report = buildFailureReport({
    mode: "approval",
    exitCode: "1",
    rawStdout: "",
    rawStderr: "TypeError: exploded\n    at run (.agent/dist/run.js:1:1)",
    reportRepository: "self-evolving/repo",
    discussionCategory: "Bug Report",
    source: source(),
    now: new Date("2026-05-05T00:00:00.000Z"),
  });
  const { client, calls } = queuedClient([
    { repository: { discussions: { nodes: [] } } },
  ]);

  const publication = publishFailureReport(report.diagnosis, client);

  assert.equal(publication.status, "skipped");
  assert.match(publication.reason, /mode approval/);
  assert.equal(calls.length, 0);
});

test("publishApprovedFailureReport publishes a pending approval report", () => {
  const report = buildFailureReport({
    mode: "approval",
    exitCode: "1",
    rawStdout: "",
    rawStderr: "TypeError: exploded\n    at run (.agent/dist/run.js:1:1)",
    reportRepository: "self-evolving/repo",
    discussionCategory: "Bug Report",
    source: source(),
    now: new Date("2026-05-05T00:00:00.000Z"),
  });
  const { client, calls } = queuedClient([
    { repository: { discussions: { nodes: [] } } },
    {
      repository: {
        id: "repo-1",
        hasDiscussionsEnabled: true,
        discussionCategories: {
          nodes: [{ id: "cat-1", name: "Bug Report" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
    { createDiscussion: { discussion: { url: "https://github.com/self-evolving/repo/discussions/2" } } },
  ]);

  const publication = publishApprovedFailureReport(report.diagnosis, client);

  assert.equal(publication.status, "created");
  assert.equal(publication.url, "https://github.com/self-evolving/repo/discussions/2");
  assert.equal(calls.length, 3);
  assert.match(calls[2]?.query || "", /createDiscussion/);
});

test("publishFailureReport matches existing discussions by fingerprint marker", () => {
  const report = buildFailureReport({
    mode: "true",
    exitCode: "1",
    rawStdout: "",
    rawStderr: "TypeError: exploded\n    at run (.agent/dist/run.js:1:1)",
    reportRepository: "self-evolving/repo",
    discussionCategory: "Bug Report",
    source: source(),
    now: new Date("2026-05-05T00:00:00.000Z"),
  });
  const { client, calls } = queuedClient([
    {
      repository: {
        discussions: {
          nodes: [{
            id: "discussion-1",
            number: 1,
            title: "older generated title with a different headline",
            url: "https://github.com/self-evolving/repo/discussions/1",
            body: `<!-- sepo-agent-failure-report fingerprint:${report.diagnosis.fingerprint} run:999 -->`,
            category: { name: "Bug Report" },
          }],
        },
      },
    },
    { node: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    { addDiscussionComment: { comment: { url: "https://github.com/self-evolving/repo/discussions/1#comment-1" } } },
  ]);

  const publication = publishFailureReport(report.diagnosis, client);

  assert.equal(publication.status, "commented");
  assert.match(publication.url, /#comment-1$/);
  assert.equal(calls.length, 3);
  assert.match(calls[0]?.query || "", /body/);
  assert.match(calls[2]?.query || "", /addDiscussionComment/);
});

test("publishFailureReport does not duplicate existing repeat occurrence comments", () => {
  const report = buildFailureReport({
    mode: "true",
    exitCode: "1",
    rawStdout: "",
    rawStderr: "TypeError: exploded\n    at run (.agent/dist/run.js:1:1)",
    reportRepository: "self-evolving/repo",
    discussionCategory: "Bug Report",
    source: source(),
    now: new Date("2026-05-05T00:00:00.000Z"),
  });
  const { client, calls } = queuedClient([
    {
      repository: {
        discussions: {
          nodes: [{
            id: "discussion-1",
            number: 1,
            title: report.diagnosis.proposedDiscussion.title,
            url: "https://github.com/self-evolving/repo/discussions/1",
            body: report.diagnosis.proposedDiscussion.body,
            category: { name: "Bug Report" },
          }],
        },
      },
    },
    {
      node: {
        comments: {
          nodes: [{
            body: `<!-- sepo-agent-failure-report-occurrence fingerprint:${report.diagnosis.fingerprint} run:${report.diagnosis.source.runId} attempt:${report.diagnosis.source.runAttempt} -->`,
            url: "https://github.com/self-evolving/repo/discussions/1#comment-1",
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ]);

  const publication = publishFailureReport(report.diagnosis, client);

  assert.equal(publication.status, "commented");
  assert.equal(publication.url, "https://github.com/self-evolving/repo/discussions/1#comment-1");
  assert.equal(publication.reason, "repeat occurrence already recorded");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !/addDiscussionComment/.test(call.query)));
});

test("publishFailureReport records separate repeat occurrences for run attempts", () => {
  const report = buildFailureReport({
    mode: "true",
    exitCode: "1",
    rawStdout: "",
    rawStderr: "TypeError: exploded\n    at run (.agent/dist/run.js:1:1)",
    reportRepository: "self-evolving/repo",
    discussionCategory: "Bug Report",
    source: { ...source(), runAttempt: "2" },
    now: new Date("2026-05-05T00:00:00.000Z"),
  });
  const { client, calls } = queuedClient([
    {
      repository: {
        discussions: {
          nodes: [{
            id: "discussion-1",
            number: 1,
            title: report.diagnosis.proposedDiscussion.title,
            url: "https://github.com/self-evolving/repo/discussions/1",
            body: report.diagnosis.proposedDiscussion.body,
            category: { name: "Bug Report" },
          }],
        },
      },
    },
    {
      node: {
        comments: {
          nodes: [{
            body: `<!-- sepo-agent-failure-report-occurrence fingerprint:${report.diagnosis.fingerprint} run:${report.diagnosis.source.runId} attempt:1 -->`,
            url: "https://github.com/self-evolving/repo/discussions/1#comment-1",
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
    { addDiscussionComment: { comment: { url: "https://github.com/self-evolving/repo/discussions/1#comment-2" } } },
  ]);

  const publication = publishFailureReport(report.diagnosis, client);

  assert.equal(publication.status, "commented");
  assert.equal(publication.url, "https://github.com/self-evolving/repo/discussions/1#comment-2");
  assert.equal(calls.length, 3);
  assert.match(String(calls[2]?.variables.body || ""), /attempt:2/);
  assert.match(calls[2]?.query || "", /addDiscussionComment/);
});
