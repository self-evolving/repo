import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  resolveTaskTimeoutMinutes,
  runResolveTaskTimeoutCli,
} from "../cli/resolve-task-timeout.js";

test("resolveTaskTimeoutMinutes uses route overrides", () => {
  assert.equal(
    resolveTaskTimeoutMinutes({
      AGENT_TASK_TIMEOUT_POLICY:
        '{"default_minutes": 30, "route_overrides": {"review": 45}}',
      ROUTE: "review",
    } as NodeJS.ProcessEnv),
    45,
  );
});

test("runResolveTaskTimeoutCli fails clearly on malformed policy", () => {
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (message?: unknown) => {
    errors.push(String(message || ""));
  };
  try {
    const code = runResolveTaskTimeoutCli({
      AGENT_TASK_TIMEOUT_POLICY: '{"default_minutes": "30"}',
      ROUTE: "answer",
    } as NodeJS.ProcessEnv);
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /Invalid AGENT_TASK_TIMEOUT_POLICY/);
    assert.match(errors.join("\n"), /default_minutes must be a positive integer/);
  } finally {
    console.error = originalError;
  }
});
