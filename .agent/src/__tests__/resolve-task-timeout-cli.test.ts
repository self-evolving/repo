import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("runResolveTaskTimeoutCli writes resolved minutes on success", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "resolve-task-timeout-"));
  const outputFile = join(tempDir, "github-output");
  const originalOutput = process.env.GITHUB_OUTPUT;
  const originalLog = console.log;
  const logs: string[] = [];
  process.env.GITHUB_OUTPUT = outputFile;
  console.log = (message?: unknown) => {
    logs.push(String(message || ""));
  };
  try {
    const code = runResolveTaskTimeoutCli({
      AGENT_TASK_TIMEOUT_POLICY:
        '{"default_minutes": 30, "route_overrides": {"review": 45}}',
      ROUTE: "review",
    } as NodeJS.ProcessEnv);
    assert.equal(code, 0);
    assert.match(readFileSync(outputFile, "utf8"), /minutes<<.*\n45\n/s);
    assert.match(logs.join("\n"), /task timeout: 45 minutes/);
  } finally {
    console.log = originalLog;
    if (originalOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = originalOutput;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
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
