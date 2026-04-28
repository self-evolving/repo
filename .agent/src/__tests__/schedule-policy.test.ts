import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  DEFAULT_SCHEDULE_MODE,
  DEFAULT_SCHEDULE_WORKFLOW_OVERRIDES,
  getScheduleModeForWorkflow,
  isScheduleMode,
  parseSchedulePolicy,
} from "../schedule-policy.js";

test("parseSchedulePolicy falls back to skip_no_updates when unset", () => {
  const policy = parseSchedulePolicy("");
  assert.equal(policy.defaultMode, DEFAULT_SCHEDULE_MODE);
  assert.equal(DEFAULT_SCHEDULE_MODE, "skip_no_updates");
  assert.deepEqual(policy.workflowOverrides, DEFAULT_SCHEDULE_WORKFLOW_OVERRIDES);
  assert.equal(policy.workflowOverrides["agent-memory-sync.yml"], "always_run");
});

test("parseSchedulePolicy accepts workflow overrides", () => {
  const policy = parseSchedulePolicy(
    '{"default_mode":"skip_no_updates","workflow_overrides":{"agent-memory-sync.yml":"always_run","agent-daily-summary.yml":"disabled"}}',
  );
  assert.equal(policy.defaultMode, "skip_no_updates");
  assert.equal(policy.workflowOverrides["agent-memory-sync.yml"], "always_run");
  assert.equal(policy.workflowOverrides["agent-daily-summary.yml"], "disabled");
});

test("parseSchedulePolicy normalizes workflow keys", () => {
  const policy = parseSchedulePolicy('{"workflow_overrides":{"AGENT-MEMORY-SCAN.YML":"disabled"}}');
  assert.equal(policy.workflowOverrides["agent-memory-scan.yml"], "disabled");
});

test("parseSchedulePolicy rejects invalid modes and workflow keys", () => {
  assert.throws(
    () => parseSchedulePolicy('{"default_mode":"banana"}'),
    /default_mode must be one of/,
  );
  assert.throws(
    () => parseSchedulePolicy('{"workflow_overrides":{"../bad.yml":"disabled"}}'),
    /Invalid workflow override key/,
  );
  assert.throws(
    () => parseSchedulePolicy('{"workflow_overrides":["agent-memory-scan.yml"]}'),
    /workflow_overrides must be an object/,
  );
});

test("getScheduleModeForWorkflow prefers workflow override over default", () => {
  const policy = parseSchedulePolicy(
    '{"default_mode":"skip_no_updates","workflow_overrides":{"agent-memory-sync.yml":"always_run"}}',
  );
  assert.equal(getScheduleModeForWorkflow(policy, "agent-memory-sync.yml"), "always_run");
  assert.equal(getScheduleModeForWorkflow(policy, "agent-memory-scan.yml"), "skip_no_updates");
});

test("isScheduleMode gates string inputs", () => {
  assert.equal(isScheduleMode("always_run"), true);
  assert.equal(isScheduleMode("skip_no_updates"), true);
  assert.equal(isScheduleMode("disabled"), true);
  assert.equal(isScheduleMode("enabled"), false);
  assert.equal(isScheduleMode(undefined), false);
});
