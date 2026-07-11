#!/usr/bin/env node
"use strict";

// Best-effort pre-runtime acknowledgement for mention-triggered portal runs.
// This file intentionally uses only Node built-ins and the runner's gh CLI so
// it can run directly after checkout, before npm install or the TypeScript
// runtime build.

const { appendFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const DEFAULT_MENTION = "@sepo-agent";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]*$/;
const REACTION_TIMEOUT_MS = 10_000;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripNonLiveMentions(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

function hasLiveMention(markdown, mention = DEFAULT_MENTION) {
  const handle = String(mention || DEFAULT_MENTION).trim();
  if (!handle) return false;

  const matcher = new RegExp(
    `(^|[\\s(])${escapeRegex(handle)}(?=[\\s.,;:!?)\\]}]|$)`,
    "m",
  );
  return matcher.test(stripNonLiveMentions(markdown));
}

function joinTitleAndBody(title, body) {
  return [title, body].filter(Boolean).join("\n\n");
}

function activeReactionTarget(eventName, payload) {
  if (eventName === "issues") {
    return {
      text: joinTitleAndBody(payload.issue?.title, payload.issue?.body),
      kind: "issue",
      id: String(payload.issue?.number || ""),
    };
  }

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return {
      text: joinTitleAndBody(payload.pull_request?.title, payload.pull_request?.body),
      kind: "issue",
      id: String(payload.pull_request?.number || ""),
    };
  }

  if (eventName === "issue_comment") {
    return {
      text: String(payload.comment?.body || ""),
      kind: "issue-comment",
      id: String(payload.comment?.id || ""),
    };
  }

  if (eventName === "pull_request_review_comment") {
    return {
      text: String(payload.comment?.body || ""),
      kind: "review-comment",
      id: String(payload.comment?.id || ""),
    };
  }

  return null;
}

function previousEditedText(eventName, payload) {
  if (payload.action !== "edited") return null;

  if (eventName === "issues") {
    return joinTitleAndBody(
      payload.changes?.title?.from ?? payload.issue?.title,
      payload.changes?.body?.from ?? payload.issue?.body,
    );
  }

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return joinTitleAndBody(
      payload.changes?.title?.from ?? payload.pull_request?.title,
      payload.changes?.body?.from ?? payload.pull_request?.body,
    );
  }

  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    return String(payload.changes?.body?.from ?? payload.comment?.body ?? "");
  }

  return null;
}

function reactionEndpoint(repository, target) {
  if (!REPOSITORY_PATTERN.test(repository) || !NUMERIC_ID_PATTERN.test(target.id)) {
    return "";
  }

  if (target.kind === "issue") {
    return `repos/${repository}/issues/${target.id}/reactions`;
  }
  if (target.kind === "issue-comment") {
    return `repos/${repository}/issues/comments/${target.id}/reactions`;
  }
  if (target.kind === "review-comment") {
    return `repos/${repository}/pulls/comments/${target.id}/reactions`;
  }
  return "";
}

function buildFastReactionPlan({
  eventName,
  payload,
  repository,
  mention = DEFAULT_MENTION,
  triggerKind = "mention",
}) {
  if (String(triggerKind || "mention").trim().toLowerCase() !== "mention") {
    return { endpoint: "", reason: "non-mention-trigger" };
  }

  const target = activeReactionTarget(eventName, payload);
  if (!target) {
    return { endpoint: "", reason: "unsupported-event" };
  }
  if (!hasLiveMention(target.text, mention)) {
    return { endpoint: "", reason: "no-live-mention" };
  }

  const previousText = previousEditedText(eventName, payload);
  if (previousText !== null && hasLiveMention(previousText, mention)) {
    return { endpoint: "", reason: "no-new-live-mention" };
  }

  const endpoint = reactionEndpoint(String(repository || "").trim(), target);
  if (!endpoint) {
    return { endpoint: "", reason: "invalid-reaction-target" };
  }

  return { endpoint, reason: "ready" };
}

function summarizeError(result) {
  if (result.error) return result.error.message;
  const stderr = String(result.stderr || "").trim();
  if (stderr) return stderr.split("\n")[0].slice(0, 500);
  return `gh exited with status ${String(result.status)}`;
}

function runFastReaction(env = process.env, spawn = spawnSync) {
  const eventPath = String(env.GITHUB_EVENT_PATH || "").trim();
  const eventName = String(env.GITHUB_EVENT_NAME || "").trim();
  if (!eventPath || !eventName) {
    return { reacted: false, reason: "missing-event-context" };
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (error) {
    return {
      reacted: false,
      reason: "invalid-event-payload",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const plan = buildFastReactionPlan({
    eventName,
    payload,
    repository: env.GITHUB_REPOSITORY,
    mention: env.INPUT_MENTION || DEFAULT_MENTION,
    triggerKind: env.INPUT_TRIGGER_KIND || "mention",
  });
  if (!plan.endpoint) {
    return { reacted: false, reason: plan.reason };
  }
  if (!String(env.GH_TOKEN || "").trim()) {
    return { reacted: false, reason: "missing-github-token" };
  }

  const result = spawn(
    "gh",
    ["api", "--method", "POST", plan.endpoint, "-f", "content=eyes"],
    {
      encoding: "utf8",
      env,
      timeout: REACTION_TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0) {
    return {
      reacted: false,
      reason: "reaction-failed",
      error: summarizeError(result),
    };
  }

  return { reacted: true, reason: "reacted" };
}

function emitResult(result, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  appendFileSync(
    outputPath,
    `reacted=${result.reacted ? "true" : "false"}\nreason=${result.reason}\n`,
  );
}

function main() {
  let result;
  try {
    result = runFastReaction();
  } catch (error) {
    result = {
      reacted: false,
      reason: "unexpected-error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    emitResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not emit fast reaction output: ${message}`);
  }

  if (result.reacted) {
    console.log("Added early eyes reaction.");
  } else if (result.error) {
    console.warn(`Early eyes reaction skipped: ${result.reason} (${result.error})`);
  } else {
    console.log(`Early eyes reaction skipped: ${result.reason}.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildFastReactionPlan,
  emitResult,
  hasLiveMention,
  runFastReaction,
  stripNonLiveMentions,
};
