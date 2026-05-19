import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  requestImpliesStackedPr,
  resolveImplementationBaseHint,
} from "../implementation-base-hint.js";

test("stacked PR language derives base_pr from the source pull request", () => {
  const hint = resolveImplementationBaseHint({
    requestText: "@sepo-agent /implement work on this as a stacked PR?",
    targetKind: "pull_request",
    targetNumber: "268",
  });

  assert.deepEqual(hint, {
    baseBranch: "",
    basePr: "268",
    source: "stacked_request",
  });
});

test("follow-up PR language derives base_pr from the source pull request", () => {
  const hint = resolveImplementationBaseHint({
    requestText: "@sepo-agent /implement make this a follow-up PR",
    targetKind: "pull_request",
    targetNumber: "274",
  });

  assert.equal(hint.basePr, "274");
  assert.equal(hint.source, "stacked_request");
});

test("implementation base hint does not derive without PR stack intent", () => {
  const hint = resolveImplementationBaseHint({
    requestText: "@sepo-agent /implement fix the failing test",
    targetKind: "pull_request",
    targetNumber: "268",
  });

  assert.deepEqual(hint, { baseBranch: "", basePr: "", source: "none" });
  assert.equal(requestImpliesStackedPr("fix the stack trace formatting"), false);
});

test("implementation base hint keeps explicitly provided base inputs", () => {
  const hint = resolveImplementationBaseHint({
    requestText: "@sepo-agent /implement as a stacked PR",
    targetKind: "pull_request",
    targetNumber: "268",
    baseBranch: "agent/parent",
  });

  assert.deepEqual(hint, {
    baseBranch: "agent/parent",
    basePr: "",
    source: "provided",
  });
});

test("implementation base hint only derives from pull request targets", () => {
  const hint = resolveImplementationBaseHint({
    requestText: "@sepo-agent /implement as a stacked PR",
    targetKind: "issue",
    targetNumber: "268",
  });

  assert.deepEqual(hint, { baseBranch: "", basePr: "", source: "none" });
});
