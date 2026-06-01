import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function runCli(env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/prepare-add-rubrics-proposal-summary.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });
}

test("add-rubrics summary reports unavailable rubrics setup explicitly", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-summary-"));

  try {
    const bodyFile = join(tempDir, "body.md");
    const result = runCli({
      BODY_FILE: bodyFile,
      RUBRICS_AVAILABLE: "false",
      RUBRICS_REF: "agent/rubrics",
      RUBRICS_STEP_OUTCOME: "success",
    });

    assert.equal(result.status, 0, result.stderr);
    const body = readFileSync(bodyFile, "utf8");
    assert.match(body, /Rubrics checkout for `agent\/rubrics` was not available/);
    assert.doesNotMatch(body, /No rubric proposal changes were committed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("add-rubrics summary reports proposal commit failures explicitly", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-summary-"));

  try {
    const bodyFile = join(tempDir, "body.md");
    const responseFile = join(tempDir, "response.json");
    writeFileSync(responseFile, '{"summary":"Prepared rubric edits."}\n');

    const result = runCli({
      BODY_FILE: bodyFile,
      BRANCH: "agent/add-rubrics-issue-1/codex-abc123",
      RESPONSE_FILE: responseFile,
      RUBRICS_AVAILABLE: "true",
      RUBRICS_COMMIT_OUTCOME: "failure",
      RUBRICS_DIR: tempDir,
      RUBRICS_REF: "agent/rubrics",
      RUBRICS_STEP_OUTCOME: "success",
      RUBRICS_VALIDATION_OUTCOME: "success",
    });

    assert.equal(result.status, 0, result.stderr);
    const body = readFileSync(bodyFile, "utf8");
    assert.match(body, /committing or pushing the proposal branch failed/);
    assert.match(body, /Branch: `agent\/add-rubrics-issue-1\/codex-abc123`/);
    assert.match(body, /Prepared rubric edits/);
    assert.doesNotMatch(body, /No rubric proposal changes were committed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("add-rubrics summary reports trusted checkout setup failures explicitly", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-summary-"));

  try {
    const bodyFile = join(tempDir, "body.md");
    const result = runCli({
      BODY_FILE: bodyFile,
      BRANCH: "agent/add-rubrics-issue-1/codex-abc123",
      RUBRICS_AVAILABLE: "true",
      RUBRICS_DIR: tempDir,
      RUBRICS_REF: "agent/rubrics",
      RUBRICS_STEP_OUTCOME: "success",
      RUBRICS_TRUSTED_SETUP_OUTCOME: "failure",
      RUBRICS_VALIDATION_OUTCOME: "success",
    });

    assert.equal(result.status, 0, result.stderr);
    const body = readFileSync(bodyFile, "utf8");
    assert.match(body, /preparing the trusted commit checkout failed/);
    assert.match(body, /Branch: `agent\/add-rubrics-issue-1\/codex-abc123`/);
    assert.doesNotMatch(body, /No rubric proposal changes were committed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("add-rubrics summary reports trusted proposal validation failures explicitly", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-summary-"));

  try {
    const bodyFile = join(tempDir, "body.md");
    const result = runCli({
      BODY_FILE: bodyFile,
      RUBRICS_AVAILABLE: "true",
      RUBRICS_DIR: tempDir,
      RUBRICS_REF: "agent/rubrics",
      RUBRICS_STEP_OUTCOME: "success",
      RUBRICS_TRUSTED_VALIDATION_OUTCOME: "failure",
      RUBRICS_VALIDATION_OUTCOME: "success",
    });

    assert.equal(result.status, 0, result.stderr);
    const body = readFileSync(bodyFile, "utf8");
    assert.match(body, /failed validation for `agent\/rubrics`/);
    assert.doesNotMatch(body, /No rubric proposal changes were committed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("add-rubrics summary reports proposal PR creation failures explicitly", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-summary-"));

  try {
    const bodyFile = join(tempDir, "body.md");
    const result = runCli({
      BODY_FILE: bodyFile,
      BRANCH: "agent/add-rubrics-issue-1/codex-abc123",
      PR_OUTCOME: "failure",
      RUBRICS_AVAILABLE: "true",
      RUBRICS_COMMIT_OUTCOME: "success",
      RUBRICS_COMMITTED: "true",
      RUBRICS_DIR: tempDir,
      RUBRICS_REF: "agent/rubrics",
      RUBRICS_STEP_OUTCOME: "success",
      RUBRICS_VALIDATION_OUTCOME: "success",
    });

    assert.equal(result.status, 0, result.stderr);
    const body = readFileSync(bodyFile, "utf8");
    assert.match(body, /opening or reusing the pull request failed/);
    assert.doesNotMatch(body, /No rubric proposal changes were committed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
