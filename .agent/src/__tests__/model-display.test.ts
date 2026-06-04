import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildModelDisplay, extractSessionModel } from "../model-display.js";

test("buildModelDisplay splits Codex GPT-5 slash reasoning into its own footer part", () => {
  const footer = buildModelDisplay({
    agent: "codex",
    reportedSessionModel: "gpt-5.5/xhigh",
    requestedModel: "gpt-5.5",
    reasoningEffort: "high",
    runnerName: "runner-1",
  });

  assert.equal(footer, "`codex` | `gpt-5.5` | `xhigh` | `runner-1`");
});

test("buildModelDisplay splits Codex GPT-5 bracket reasoning into its own footer part", () => {
  const footer = buildModelDisplay({
    agent: "codex",
    reportedSessionModel: "gpt-5.5[high]",
    requestedModel: "gpt-5.5",
    reasoningEffort: "medium",
    runnerName: "runner-1",
  });

  assert.equal(footer, "`codex` | `gpt-5.5` | `high` | `runner-1`");
});

test("buildModelDisplay keeps plain fallback model plus reasoning stable", () => {
  const reportedModel = extractSessionModel('{"type":"message","text":"compact resume"}\n') || "gpt-5.5";
  const footer = buildModelDisplay({
    agent: "codex",
    reportedSessionModel: reportedModel,
    requestedModel: "gpt-5.5",
    reasoningEffort: "high",
    runnerName: "runner-5",
  });

  assert.equal(footer, "`codex` | `gpt-5.5` | `high` | `runner-5`");
});

test("buildModelDisplay suppresses separate reasoning for non-GPT-5 Codex suffixes", () => {
  const footer = buildModelDisplay({
    agent: "codex",
    reportedSessionModel: "gpt-4.1/high",
    requestedModel: "gpt-4.1",
    reasoningEffort: "medium",
    runnerName: "runner-3",
  });

  assert.equal(footer, "`codex` | `gpt-4.1/high` | `runner-3`");
});

test("buildModelDisplay leaves non-Codex encoded-looking models unchanged", () => {
  const footer = buildModelDisplay({
    agent: "claude",
    reportedSessionModel: "claude-opus-4/high",
    requestedModel: "claude-opus-4",
    reasoningEffort: "max",
    runnerName: "runner-2",
  });

  assert.equal(footer, "`claude` | `claude-opus-4/high` | `max` | `runner-2`");
});

test("buildModelDisplay prefers concrete Claude requested model over default session alias", () => {
  const footer = buildModelDisplay({
    agent: "claude",
    reportedSessionModel: "default",
    requestedModel: "claude-opus-4-8",
    reasoningEffort: "high",
    runnerName: "runner-8",
  });

  assert.equal(footer, "`claude` | `claude-opus-4-8` | `high` | `runner-8`");
});

test("buildModelDisplay prefers concrete Claude session model over requested model", () => {
  const footer = buildModelDisplay({
    agent: "claude",
    reportedSessionModel: "claude-sonnet-4-5",
    requestedModel: "claude-opus-4-8",
    reasoningEffort: "medium",
    runnerName: "runner-4",
  });

  assert.equal(footer, "`claude` | `claude-sonnet-4-5` | `medium` | `runner-4`");
});

test("buildModelDisplay shows default model for Claude default alias only", () => {
  const footer = buildModelDisplay({
    agent: "claude",
    reportedSessionModel: "default",
    requestedModel: "",
    reasoningEffort: "high",
    runnerName: "runner-7",
  });

  assert.equal(footer, "`claude` | `default model` | `high` | `runner-7`");
});

test("buildModelDisplay marks Claude non-default aliases as aliases", () => {
  const footer = buildModelDisplay({
    agent: "claude",
    reportedSessionModel: "opus",
    requestedModel: "",
    reasoningEffort: "high",
    runnerName: "runner-9",
  });

  assert.equal(footer, "`claude` | `opus alias` | `high` | `runner-9`");
});

test("buildModelDisplay falls back to requested model for partial session metadata", () => {
  const reportedModel = extractSessionModel('{"type":"session","sessionId":"sess-1","model":null}\n');
  const footer = buildModelDisplay({
    agent: "claude",
    reportedSessionModel: reportedModel,
    requestedModel: "claude-opus-4-8",
    reasoningEffort: "high",
    runnerName: "runner-10",
  });

  assert.equal(footer, "`claude` | `claude-opus-4-8` | `high` | `runner-10`");
});

test("extractSessionModel returns compact session model", () => {
  const reportedModel = extractSessionModel(
    '{"type":"message","text":"ignored"}\n{"type":"session","sessionId":"sess-2","model":"claude-opus-4-8"}\n',
  );

  assert.equal(reportedModel, "claude-opus-4-8");
});
