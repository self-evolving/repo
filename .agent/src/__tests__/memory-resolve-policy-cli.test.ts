import { test } from "node:test";
import { strict as assert } from "node:assert";

import { resolveMode } from "../cli/memory/resolve-policy.js";

test("resolveMode falls closed to 'disabled' on malformed AGENT_MEMORY_POLICY without mutating exitCode", () => {
  const originalPolicy = process.env.AGENT_MEMORY_POLICY;
  const originalRoute = process.env.ROUTE;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  process.env.AGENT_MEMORY_POLICY = '{"default_mode": "banana"}';
  process.env.ROUTE = "answer";
  console.error = () => { /* swallow */ };
  try {
    assert.equal(resolveMode(), "disabled");
    assert.equal(process.exitCode, originalExitCode);
  } finally {
    process.env.AGENT_MEMORY_POLICY = originalPolicy;
    process.env.ROUTE = originalRoute;
    console.error = originalError;
  }
});
