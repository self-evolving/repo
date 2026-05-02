import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  DEFAULT_TASK_TIMEOUT_MINUTES,
  MAX_TASK_TIMEOUT_MINUTES,
  getTaskTimeoutMinutesForRoute,
  parseTaskTimeoutPolicy,
} from "../task-timeout-policy.js";

test("parseTaskTimeoutPolicy falls back to default minutes when unset", () => {
  const policy = parseTaskTimeoutPolicy("");
  assert.equal(policy.defaultMinutes, DEFAULT_TASK_TIMEOUT_MINUTES);
  assert.deepEqual(policy.routeOverrides, {});
  assert.equal(DEFAULT_TASK_TIMEOUT_MINUTES, 30);
  assert.equal(MAX_TASK_TIMEOUT_MINUTES, 360);
});

test("parseTaskTimeoutPolicy accepts default_minutes alone", () => {
  const policy = parseTaskTimeoutPolicy('{"default_minutes": 45}');
  assert.equal(policy.defaultMinutes, 45);
  assert.deepEqual(policy.routeOverrides, {});
});

test("parseTaskTimeoutPolicy accepts route_overrides alone", () => {
  const policy = parseTaskTimeoutPolicy(
    '{"route_overrides": {"review": 45, "fix-pr": 60}}',
  );
  assert.equal(policy.defaultMinutes, DEFAULT_TASK_TIMEOUT_MINUTES);
  assert.equal(policy.routeOverrides.review, 45);
  assert.equal(policy.routeOverrides["fix-pr"], 60);
});

test("parseTaskTimeoutPolicy normalizes route keys to lowercase", () => {
  const policy = parseTaskTimeoutPolicy('{"route_overrides": {"REVIEW": 40}}');
  assert.equal(policy.routeOverrides.review, 40);
  assert.equal(policy.routeOverrides.REVIEW, undefined);
});

test("parseTaskTimeoutPolicy rejects invalid minute values", () => {
  assert.throws(
    () => parseTaskTimeoutPolicy('{"default_minutes": 0}'),
    /default_minutes must be a positive integer/,
  );
  assert.throws(
    () => parseTaskTimeoutPolicy('{"default_minutes": 1.5}'),
    /default_minutes must be a positive integer/,
  );
  assert.throws(
    () => parseTaskTimeoutPolicy('{"route_overrides": {"answer": "30"}}'),
    /route_overrides\.answer must be a positive integer/,
  );
  assert.throws(
    () => parseTaskTimeoutPolicy('{"default_minutes": 361}'),
    /default_minutes must be at most 360/,
  );
  assert.throws(
    () => parseTaskTimeoutPolicy('{"route_overrides": {"answer": 1000}}'),
    /route_overrides\.answer must be at most 360/,
  );
});

test("parseTaskTimeoutPolicy rejects non-object route_overrides", () => {
  assert.throws(
    () => parseTaskTimeoutPolicy('{"route_overrides": ["answer", "review"]}'),
    /route_overrides must be an object/,
  );
});

test("parseTaskTimeoutPolicy rejects invalid route keys", () => {
  assert.throws(
    () => parseTaskTimeoutPolicy('{"route_overrides": {"!bad": 30}}'),
    /Invalid route override key/,
  );
});

test("getTaskTimeoutMinutesForRoute prefers override over default", () => {
  const policy = parseTaskTimeoutPolicy(
    '{"default_minutes": 30, "route_overrides": {"implement": 75}}',
  );
  assert.equal(getTaskTimeoutMinutesForRoute(policy, "implement"), 75);
  assert.equal(getTaskTimeoutMinutesForRoute(policy, "review"), 30);
});
