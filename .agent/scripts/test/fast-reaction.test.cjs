"use strict";

const { strict: assert } = require("node:assert");
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const {
  buildFastReactionPlan,
  hasLiveMention,
} = require("../fast-reaction.cjs");

const SCRIPT_PATH = resolve(__dirname, "../fast-reaction.cjs");
const MENTION = "@sepo-agent";

function parseOutputs(text) {
  return Object.fromEntries(
    text.trim().split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

function runCli({ eventName, payload, ghStatus = 0, extraEnv = {} }) {
  const tempDir = mkdtempSync(join(tmpdir(), "fast-reaction-"));
  const eventPath = join(tempDir, "event.json");
  const outputPath = join(tempDir, "output.txt");
  const capturePath = join(tempDir, "gh-args.txt");
  const ghPath = join(tempDir, "gh");

  writeFileSync(eventPath, JSON.stringify(payload));
  writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "test \"${GH_TOKEN:-}\" = \"workflow-token\"",
      "printf '%s\\n' \"$@\" > \"${GH_CAPTURE}\"",
      "exit \"${GH_STUB_STATUS:-0}\"",
    ].join("\n") + "\n",
  );
  chmodSync(ghPath, 0o755);

  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      GH_CAPTURE: capturePath,
      GH_STUB_STATUS: String(ghStatus),
      GH_TOKEN: "workflow-token",
      INPUT_MENTION: MENTION,
      INPUT_TRIGGER_KIND: "mention",
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...extraEnv,
    },
  });

  return {
    capturePath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
    outputs: parseOutputs(readFileSync(outputPath, "utf8")),
    result,
  };
}

test("fast reaction selects REST endpoints for supported issue and PR surfaces", () => {
  const cases = [
    {
      name: "issue body",
      eventName: "issues",
      payload: { action: "opened", issue: { number: 11, title: "Help", body: `${MENTION} help` } },
      endpoint: "repos/self-evolving/repo/issues/11/reactions",
    },
    {
      name: "pull request body",
      eventName: "pull_request",
      payload: { action: "opened", pull_request: { number: 12, title: `${MENTION} review`, body: "" } },
      endpoint: "repos/self-evolving/repo/issues/12/reactions",
    },
    {
      name: "issue comment",
      eventName: "issue_comment",
      payload: { action: "created", issue: { number: 13 }, comment: { id: 101, body: `${MENTION} answer` } },
      endpoint: "repos/self-evolving/repo/issues/comments/101/reactions",
    },
    {
      name: "pull request comment",
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 14, pull_request: {} },
        comment: { id: 102, body: `${MENTION} answer` },
      },
      endpoint: "repos/self-evolving/repo/issues/comments/102/reactions",
    },
    {
      name: "pull request review comment",
      eventName: "pull_request_review_comment",
      payload: { action: "created", comment: { id: 103, body: `${MENTION} fix this` } },
      endpoint: "repos/self-evolving/repo/pulls/comments/103/reactions",
    },
  ];

  for (const reactionCase of cases) {
    const run = runCli(reactionCase);
    try {
      assert.equal(run.result.status, 0, `${reactionCase.name}: ${run.result.stderr}`);
      assert.deepEqual(run.outputs, { reacted: "true", reason: "reacted" });
      assert.deepEqual(
        readFileSync(run.capturePath, "utf8").trim().split("\n"),
        ["api", "--method", "POST", reactionCase.endpoint, "-f", "content=eyes"],
        reactionCase.name,
      );
    } finally {
      run.cleanup();
    }
  }
});

test("fast reaction ignores quoted, fenced, inline-code, and inactive-parent mentions", () => {
  assert.equal(hasLiveMention(`> ${MENTION} quoted`, MENTION), false);
  assert.equal(hasLiveMention(`\`\`\`md\n${MENTION} fenced\n\`\`\``, MENTION), false);
  assert.equal(hasLiveMention(`~~~md\n${MENTION} fenced\n~~~`, MENTION), false);
  assert.equal(hasLiveMention(`Use \`${MENTION}\` as an example`, MENTION), false);
  assert.equal(hasLiveMention(`prefix${MENTION}suffix`, MENTION), false);
  assert.equal(hasLiveMention(`Please ${MENTION}, take a look`, MENTION), true);

  const plan = buildFastReactionPlan({
    eventName: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 22, body: `${MENTION} appears only in the parent` },
      comment: { id: 201, body: "No active mention" },
    },
    repository: "self-evolving/repo",
    mention: MENTION,
  });
  assert.deepEqual(plan, { endpoint: "", reason: "no-live-mention" });
});

test("fast reaction only acknowledges edited text when it adds a live mention", () => {
  const existingMention = buildFastReactionPlan({
    eventName: "issue_comment",
    payload: {
      action: "edited",
      changes: { body: { from: `${MENTION} before` } },
      comment: { id: 301, body: `${MENTION} after` },
    },
    repository: "self-evolving/repo",
    mention: MENTION,
  });
  assert.deepEqual(existingMention, { endpoint: "", reason: "no-new-live-mention" });

  const addedMention = buildFastReactionPlan({
    eventName: "issue_comment",
    payload: {
      action: "edited",
      changes: { body: { from: "No mention before" } },
      comment: { id: 302, body: `${MENTION} after` },
    },
    repository: "self-evolving/repo",
    mention: MENTION,
  });
  assert.deepEqual(addedMention, {
    endpoint: "repos/self-evolving/repo/issues/comments/302/reactions",
    reason: "ready",
  });
});

test("fast reaction leaves discussions and pull request reviews to fallback", () => {
  const cases = [
    { eventName: "discussion", payload: { discussion: { number: 1, body: MENTION } } },
    {
      eventName: "discussion_comment",
      payload: { discussion: { number: 1 }, comment: { id: 2, body: MENTION } },
    },
    {
      eventName: "pull_request_review",
      payload: { pull_request: { number: 1 }, review: { id: 3, body: MENTION } },
    },
  ];

  for (const reactionCase of cases) {
    assert.deepEqual(
      buildFastReactionPlan({
        ...reactionCase,
        repository: "self-evolving/repo",
        mention: MENTION,
      }),
      { endpoint: "", reason: "unsupported-event" },
      reactionCase.eventName,
    );
  }
});

test("fast reaction failure is non-fatal and emits reacted=false", () => {
  const run = runCli({
    eventName: "issues",
    payload: { action: "opened", issue: { number: 44, title: MENTION, body: "" } },
    ghStatus: 1,
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(run.outputs, { reacted: "false", reason: "reaction-failed" });
    assert.match(run.result.stderr, /Early eyes reaction skipped: reaction-failed/);
  } finally {
    run.cleanup();
  }
});

test("fast reaction skips non-mention trigger kinds", () => {
  const run = runCli({
    eventName: "issues",
    payload: { action: "labeled", issue: { number: 55, title: MENTION, body: "" } },
    extraEnv: { INPUT_TRIGGER_KIND: "label" },
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(run.outputs, { reacted: "false", reason: "non-mention-trigger" });
  } finally {
    run.cleanup();
  }
});
