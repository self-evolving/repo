import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildAgentFailureReportInput,
  buildFailureDiscussionBody,
  buildFailureFingerprint,
  DEFAULT_FAILURE_REPORT_DISCUSSION_CATEGORY,
  DEFAULT_FAILURE_REPORT_REPOSITORY,
  postAgentFailureReport,
  resolveFailureReportEnabled,
} from "../failure-report.js";
import type { AgentFailureReportInput } from "../failure-report.js";
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

function baseInput(overrides: Partial<AgentFailureReportInput> = {}): AgentFailureReportInput {
  return {
    enabled: "auto",
    reportRepository: "self-evolving/repo",
    discussionCategory: "Bug Report",
    sourceRepository: "example/project",
    sourceRepositoryPrivate: false,
    route: "implement",
    workflow: "agent-implement.yml",
    targetKind: "issue",
    targetNumber: "26",
    targetUrl: "https://github.com/example/project/issues/26",
    sourceKind: "workflow_dispatch",
    requestedBy: "octo",
    exitCode: "1",
    runId: "12345",
    runAttempt: "1",
    runUrl: "https://github.com/example/project/actions/runs/12345",
    serverUrl: "https://github.com",
    sha: "0123456789abcdef0123456789abcdef01234567",
    refName: "main",
    errorSummary: "stderr tail:\nError: boom",
    seenAt: "2026-05-03T00:00:00.000Z",
    ...overrides,
  };
}

test("resolveFailureReportEnabled defaults to public repos and skips private repos", () => {
  assert.deepEqual(resolveFailureReportEnabled("auto", false), {
    enabled: true,
    reason: "auto failure reporting is enabled for public repositories",
  });
  assert.deepEqual(resolveFailureReportEnabled("auto", true), {
    enabled: false,
    reason: "auto failure reporting is disabled for private repositories",
  });
  assert.deepEqual(resolveFailureReportEnabled("false", false), {
    enabled: false,
    reason: "failure reporting is disabled",
  });
});

test("buildAgentFailureReportInput uses defaults and redacts captured failure output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "failure-report-"));
  const stderrFile = join(tempDir, "stderr.log");
  writeFileSync(stderrFile, "Error with github_pat_abcdefghijklmnopqrstuvwxyz\n", "utf8");

  try {
    const input = buildAgentFailureReportInput({
      AGENT_RAW_STDERR_FILE: stderrFile,
      GITHUB_REPOSITORY: "example/project",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SERVER_URL: "https://github.com",
      ROUTE: "answer",
      WORKFLOW: "agent-router.yml",
      TARGET_KIND: "repository",
      TARGET_NUMBER: "0",
      AGENT_EXIT_CODE: "1",
      SOURCE_REPOSITORY_PRIVATE: "false",
    } as NodeJS.ProcessEnv, new Date("2026-05-03T00:00:00.000Z"));

    assert.equal(input.reportRepository, DEFAULT_FAILURE_REPORT_REPOSITORY);
    assert.equal(input.discussionCategory, DEFAULT_FAILURE_REPORT_DISCUSSION_CATEGORY);
    assert.equal(input.runUrl, "https://github.com/example/project/actions/runs/123");
    assert.match(input.errorSummary, /redacted github token/);
    assert.doesNotMatch(input.errorSummary, /github_pat_/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("postAgentFailureReport creates a fingerprint discussion on first failure", () => {
  const input = baseInput();
  const { client, calls } = queuedClient([
    {
      repository: {
        discussions: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
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
    { createDiscussion: { discussion: { url: "https://github.com/self-evolving/repo/discussions/10" } } },
  ]);

  const result = postAgentFailureReport(input, client);

  assert.equal(result.status, "created");
  assert.equal(result.discussionUrl, "https://github.com/self-evolving/repo/discussions/10");
  assert.match(calls[0]?.query || "", /discussions\(first: 100/);
  assert.match(String(calls[2]?.variables.title), /^\[agent-failure:[a-f0-9]{12}\]/);
  assert.match(String(calls[2]?.variables.body), /Agent Failure Report/);
  assert.match(String(calls[2]?.variables.body), /sepo-agent-failure-report/);
});

test("postAgentFailureReport comments on an existing fingerprint discussion", () => {
  const input = baseInput({ runId: "22222" });
  const fingerprint = buildFailureFingerprint(input);
  const { client } = queuedClient([
    {
      repository: {
        discussions: {
          nodes: [{
            id: "discussion-1",
            number: 10,
            title: `[agent-failure:${fingerprint.slice(0, 12)}] example/project implement issue #26 failed`,
            url: "https://github.com/self-evolving/repo/discussions/10",
            body: buildFailureDiscussionBody(baseInput({ runId: "11111" }), fingerprint),
            category: { name: "Bug Report" },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
    {
      repository: {
        discussion: {
          comments: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    { addDiscussionComment: { comment: { url: "https://github.com/self-evolving/repo/discussions/10#discussioncomment-2" } } },
  ]);

  const result = postAgentFailureReport(input, client);

  assert.equal(result.status, "commented");
  assert.equal(result.commentUrl, "https://github.com/self-evolving/repo/discussions/10#discussioncomment-2");
});

test("postAgentFailureReport skips duplicate run attempts", () => {
  const input = baseInput();
  const fingerprint = buildFailureFingerprint(input);
  const body = buildFailureDiscussionBody(input, fingerprint);
  const { client, calls } = queuedClient([
    {
      repository: {
        discussions: {
          nodes: [{
            id: "discussion-1",
            number: 10,
            title: `[agent-failure:${fingerprint.slice(0, 12)}] example/project implement issue #26 failed`,
            url: "https://github.com/self-evolving/repo/discussions/10",
            body,
            category: { name: "Bug Report" },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
    {
      repository: {
        discussion: {
          comments: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ]);

  const result = postAgentFailureReport(input, client);

  assert.equal(result.status, "duplicate");
  assert.equal(calls.length, 2);
});

test("postAgentFailureReport does not call GitHub when reporting is skipped", () => {
  const { client, calls } = queuedClient([]);
  const result = postAgentFailureReport(
    baseInput({ sourceRepositoryPrivate: true }),
    client,
  );

  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});
