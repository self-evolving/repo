import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildModelDisplay, extractSessionModel } from "../model-display.js";

test("buildModelDisplay splits Codex GPT-5 slash reasoning into its own footer part", () => {
  const footer = buildModelDisplay({
    agent: "codex",
    model: "gpt-5.5/xhigh",
    reasoningEffort: "high",
    runnerName: "runner-1",
  });

  assert.equal(footer, "`codex` | `gpt-5.5` | `xhigh` | `runner-1`");
});

test("buildModelDisplay splits Codex GPT-5 bracket reasoning into its own footer part", () => {
  const footer = buildModelDisplay({
    agent: "codex",
    model: "gpt-5.5[high]",
    reasoningEffort: "medium",
    runnerName: "runner-1",
  });

  assert.equal(footer, "`codex` | `gpt-5.5` | `high` | `runner-1`");
});

test("buildModelDisplay keeps plain fallback model plus reasoning stable", () => {
  const reportedModel = extractSessionModel('{"type":"message","text":"compact resume"}\n') || "gpt-5.5";
  const footer = buildModelDisplay({
    agent: "codex",
    model: reportedModel,
    reasoningEffort: "high",
    runnerName: "runner-5",
  });

  assert.equal(footer, "`codex` | `gpt-5.5` | `high` | `runner-5`");
});

test("buildModelDisplay suppresses separate reasoning for non-GPT-5 Codex suffixes", () => {
  const footer = buildModelDisplay({
    agent: "codex",
    model: "gpt-4.1/high",
    reasoningEffort: "medium",
    runnerName: "runner-3",
  });

  assert.equal(footer, "`codex` | `gpt-4.1/high` | `runner-3`");
});

test("buildModelDisplay leaves non-Codex encoded-looking models unchanged", () => {
  const footer = buildModelDisplay({
    agent: "claude",
    model: "claude-opus-4/high",
    reasoningEffort: "max",
    runnerName: "runner-2",
  });

  assert.equal(footer, "`claude` | `claude-opus-4/high` | `max` | `runner-2`");
});
