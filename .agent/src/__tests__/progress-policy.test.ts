import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  resolveProgressMode,
  resolveProgressPolicy,
} from "../cli/progress/resolve-policy.js";
import {
  DEFAULT_ORCHESTRATION_PROGRESS_MODE,
  DEFAULT_PROGRESS_MODE,
  DEFAULT_PROGRESS_ROUTE_OVERRIDES,
  getProgressModeForOrchestration,
  getProgressModeForRoute,
  isProgressMode,
  parseProgressPolicy,
  progressModeAllowsCancel,
  progressModeAllowsComment,
  progressTargetSupportsComments,
} from "../progress-policy.js";

test("parseProgressPolicy defaults implement and fix-pr to enabled with cancellation", () => {
  const policy = parseProgressPolicy("");
  assert.equal(policy.defaultMode, DEFAULT_PROGRESS_MODE);
  assert.equal(DEFAULT_PROGRESS_MODE, "disabled");
  assert.equal(policy.orchestrationMode, DEFAULT_ORCHESTRATION_PROGRESS_MODE);
  assert.equal(DEFAULT_ORCHESTRATION_PROGRESS_MODE, "disabled");
  assert.deepEqual(policy.routeOverrides, DEFAULT_PROGRESS_ROUTE_OVERRIDES);
  assert.equal(getProgressModeForRoute(policy, "implement"), "enabled");
  assert.equal(getProgressModeForRoute(policy, "fix-pr"), "enabled");
  assert.equal(progressModeAllowsComment(getProgressModeForRoute(policy, "implement")), true);
  assert.equal(progressModeAllowsCancel(getProgressModeForRoute(policy, "implement")), true);
});

test("parseProgressPolicy disables review and enables answer reporting by default", () => {
  const policy = parseProgressPolicy("");
  assert.equal(getProgressModeForRoute(policy, "review"), "disabled");
  assert.equal(getProgressModeForRoute(policy, "answer"), "report-only");
  assert.equal(progressModeAllowsComment(getProgressModeForRoute(policy, "review")), false);
  assert.equal(progressModeAllowsComment(getProgressModeForRoute(policy, "answer")), true);
  assert.equal(progressModeAllowsCancel(getProgressModeForRoute(policy, "answer")), false);
});

test("parseProgressPolicy accepts default mode, route overrides, and orchestration mode", () => {
  const policy = parseProgressPolicy(
    '{"default_mode":"report-only","route_overrides":{"fix-pr":"disabled","answer":"enabled"},"orchestration_mode":"report-only"}',
  );
  assert.equal(policy.defaultMode, "report-only");
  assert.equal(getProgressModeForRoute(policy, "implement"), "enabled");
  assert.equal(getProgressModeForRoute(policy, "fix-pr"), "disabled");
  assert.equal(getProgressModeForRoute(policy, "answer"), "enabled");
  assert.equal(getProgressModeForRoute(policy, "dispatch"), "report-only");
  assert.equal(getProgressModeForOrchestration(policy), "report-only");
});

test("parseProgressPolicy normalizes route keys to lowercase", () => {
  const policy = parseProgressPolicy('{"route_overrides":{"IMPLEMENT":"report-only"}}');
  assert.equal(policy.routeOverrides.implement, "report-only");
  assert.equal(policy.routeOverrides.IMPLEMENT, undefined);
});

test("parseProgressPolicy rejects unknown modes and invalid route keys", () => {
  assert.throws(
    () => parseProgressPolicy('{"default_mode":"banana"}'),
    /default_mode must be one of/,
  );
  assert.throws(
    () => parseProgressPolicy('{"route_overrides":{"../bad":"enabled"}}'),
    /Invalid route override key/,
  );
  assert.throws(
    () => parseProgressPolicy('{"route_overrides":["implement"]}'),
    /route_overrides must be an object/,
  );
  assert.throws(
    () => parseProgressPolicy('{"orchestration_mode":"enabled"}'),
    /orchestration_mode must be one of report-only, disabled/,
  );
});

test("resolveProgressMode falls closed to disabled on malformed policy", () => {
  const originalError = console.error;
  console.error = () => { /* swallow */ };
  try {
    assert.equal(
      resolveProgressMode({
        ROUTE: "implement",
        AGENT_PROGRESS_POLICY: '{"default_mode":"banana"}',
      }),
      "disabled",
    );
  } finally {
    console.error = originalError;
  }
});

test("resolveProgressMode disables progress when orchestration is enabled", () => {
  assert.equal(
    resolveProgressMode({
      ROUTE: "implement",
      ORCHESTRATION_ENABLED: "true",
    }),
    "disabled",
  );
});

test("resolveProgressMode keeps orchestration disabled over custom progress policy", () => {
  assert.equal(
    resolveProgressMode({
      AGENT_PROGRESS_POLICY: '{"default_mode":"enabled","route_overrides":{"implement":"enabled"}}',
      ORCHESTRATION_ENABLED: "true",
      ROUTE: "implement",
    }),
    "disabled",
  );
});

test("resolveProgressPolicy enables report-only orchestration progress by explicit opt-in", () => {
  const resolution = resolveProgressPolicy({
    AGENT_PROGRESS_POLICY: '{"default_mode":"disabled","orchestration_mode":"report-only"}',
    ORCHESTRATION_ENABLED: "true",
    RESPONSE_KIND: "issue_comment",
    ROUTE: "implement",
    TARGET_KIND: "issue",
  });

  assert.equal(resolution.mode, "report-only");
  assert.equal(resolution.enabled, true);
  assert.equal(resolution.cancelEnabled, false);
  assert.equal(resolution.targetSupported, true);
  assert.equal(resolution.responseSupported, true);
});

test("resolveProgressPolicy disables answer progress for review comment replies", () => {
  const resolution = resolveProgressPolicy({
    AGENT_PROGRESS_POLICY: '{"route_overrides":{"answer":"enabled"}}',
    RESPONSE_KIND: "review_comment_reply",
    ROUTE: "answer",
    TARGET_KIND: "pull_request",
  });

  assert.equal(resolution.mode, "enabled");
  assert.equal(resolution.targetSupported, true);
  assert.equal(resolution.responseSupported, false);
  assert.equal(resolution.enabled, false);
  assert.equal(resolution.cancelEnabled, false);
});

test("resolveProgressPolicy keeps answer progress for mergeable responses", () => {
  const issueResolution = resolveProgressPolicy({
    RESPONSE_KIND: "issue_comment",
    ROUTE: "answer",
    TARGET_KIND: "issue",
  });
  const prResolution = resolveProgressPolicy({
    RESPONSE_KIND: "pr_comment",
    ROUTE: "answer",
    TARGET_KIND: "pull_request",
  });

  assert.equal(issueResolution.enabled, true);
  assert.equal(issueResolution.cancelEnabled, false);
  assert.equal(issueResolution.responseSupported, true);
  assert.equal(prResolution.enabled, true);
  assert.equal(prResolution.responseSupported, true);
});

test("mode predicates distinguish reporting from cancellation", () => {
  assert.equal(progressModeAllowsComment("enabled"), true);
  assert.equal(progressModeAllowsComment("report-only"), true);
  assert.equal(progressModeAllowsComment("disabled"), false);

  assert.equal(progressModeAllowsCancel("enabled"), true);
  assert.equal(progressModeAllowsCancel("report-only"), false);
  assert.equal(progressModeAllowsCancel("disabled"), false);
});

test("target support is limited to issues and pull requests", () => {
  assert.equal(progressTargetSupportsComments("issue"), true);
  assert.equal(progressTargetSupportsComments("pull_request"), true);
  assert.equal(progressTargetSupportsComments("pr"), true);
  assert.equal(progressTargetSupportsComments("discussion"), false);
  assert.equal(progressTargetSupportsComments("repository"), false);
});

test("isProgressMode gates string inputs", () => {
  assert.equal(isProgressMode("enabled"), true);
  assert.equal(isProgressMode("report-only"), true);
  assert.equal(isProgressMode("disabled"), true);
  assert.equal(isProgressMode("anything"), false);
  assert.equal(isProgressMode(undefined), false);
});
