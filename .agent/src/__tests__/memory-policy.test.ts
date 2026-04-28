import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  DEFAULT_MEMORY_MODE,
  getMemoryModeForRoute,
  isMemoryMode,
  memoryModeAllowsRead,
  memoryModeAllowsWrite,
  parseMemoryPolicy,
} from "../memory-policy.js";

test("parseMemoryPolicy falls back to default-enabled when unset", () => {
  const policy = parseMemoryPolicy("");
  assert.equal(policy.defaultMode, DEFAULT_MEMORY_MODE);
  assert.deepEqual(policy.routeOverrides, {});
  assert.equal(DEFAULT_MEMORY_MODE, "enabled");
});

test("parseMemoryPolicy accepts default_mode alone", () => {
  const policy = parseMemoryPolicy('{"default_mode": "read-only"}');
  assert.equal(policy.defaultMode, "read-only");
  assert.deepEqual(policy.routeOverrides, {});
});

test("parseMemoryPolicy accepts route_overrides alone", () => {
  const policy = parseMemoryPolicy(
    '{"route_overrides": {"review": "read-only", "dispatch": "disabled"}}',
  );
  assert.equal(policy.defaultMode, DEFAULT_MEMORY_MODE);
  assert.equal(policy.routeOverrides.review, "read-only");
  assert.equal(policy.routeOverrides.dispatch, "disabled");
});

test("parseMemoryPolicy normalizes route keys to lowercase", () => {
  const policy = parseMemoryPolicy('{"route_overrides": {"REVIEW": "disabled"}}');
  assert.equal(policy.routeOverrides.review, "disabled");
  assert.equal(policy.routeOverrides.REVIEW, undefined);
});

test("parseMemoryPolicy rejects unknown modes", () => {
  assert.throws(
    () => parseMemoryPolicy('{"default_mode": "banana"}'),
    /default_mode must be one of/,
  );
  assert.throws(
    () =>
      parseMemoryPolicy('{"route_overrides": {"answer": "banana"}}'),
    /route_overrides\.answer must be one of/,
  );
});

test("parseMemoryPolicy rejects non-object route_overrides", () => {
  assert.throws(
    () => parseMemoryPolicy('{"route_overrides": ["answer", "review"]}'),
    /route_overrides must be an object/,
  );
});

test("parseMemoryPolicy rejects invalid route keys", () => {
  assert.throws(
    () => parseMemoryPolicy('{"route_overrides": {"!bad": "enabled"}}'),
    /Invalid route override key/,
  );
});

test("getMemoryModeForRoute prefers override over default", () => {
  const policy = parseMemoryPolicy(
    '{"default_mode": "enabled", "route_overrides": {"review": "read-only"}}',
  );
  assert.equal(getMemoryModeForRoute(policy, "review"), "read-only");
  assert.equal(getMemoryModeForRoute(policy, "implement"), "enabled");
});

test("getMemoryModeForRoute treats missing route as default mode", () => {
  const policy = parseMemoryPolicy('{"default_mode": "disabled"}');
  assert.equal(getMemoryModeForRoute(policy, ""), "disabled");
  assert.equal(getMemoryModeForRoute(policy, "anything"), "disabled");
});

test("mode predicates: read_enabled covers enabled + read-only; write_enabled covers enabled only", () => {
  assert.equal(memoryModeAllowsRead("enabled"), true);
  assert.equal(memoryModeAllowsRead("read-only"), true);
  assert.equal(memoryModeAllowsRead("disabled"), false);

  assert.equal(memoryModeAllowsWrite("enabled"), true);
  assert.equal(memoryModeAllowsWrite("read-only"), false);
  assert.equal(memoryModeAllowsWrite("disabled"), false);
});

test("isMemoryMode gates string inputs", () => {
  assert.equal(isMemoryMode("enabled"), true);
  assert.equal(isMemoryMode("read-only"), true);
  assert.equal(isMemoryMode("disabled"), true);
  assert.equal(isMemoryMode("anything"), false);
  assert.equal(isMemoryMode(undefined), false);
  assert.equal(isMemoryMode(42), false);
});
