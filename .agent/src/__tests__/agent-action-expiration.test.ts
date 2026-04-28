import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = resolve(__dirname, "../../..");
const scriptPath = join(
  repoRoot,
  ".github/actions/check-agent-action-expiration/check-expiration.sh",
);

function runExpirationCheck(expiresAt: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
} {
  const dir = mkdtempSync(join(tmpdir(), "agent-action-expiration-"));
  const outputPath = join(dir, "github-output.txt");
  const result = spawnSync("bash", [scriptPath], {
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      INPUT_EXPIRES_AT: expiresAt,
    },
    encoding: "utf8",
  });
  let outputs: Record<string, string> = {};
  try {
    outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
  } catch {
    outputs = {};
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs,
  };
}

test("check-agent-action-expiration marks future and past dates", () => {
  const future = runExpirationCheck("2099-01-01");
  assert.equal(future.status, 0);
  assert.equal(future.outputs.expired, "false");
  assert.equal(future.outputs.expires_at, "2099-01-01");
  assert.match(future.outputs.today, /^\d{4}-\d{2}-\d{2}$/);

  const past = runExpirationCheck("2000-01-01");
  assert.equal(past.status, 0);
  assert.equal(past.outputs.expired, "true");
  assert.equal(past.outputs.expires_at, "2000-01-01");
});

test("check-agent-action-expiration rejects invalid dates", () => {
  const invalidFormat = runExpirationCheck("01-01-2099");
  assert.equal(invalidFormat.status, 2);
  assert.match(invalidFormat.stderr, /YYYY-MM-DD/);

  const impossibleDate = runExpirationCheck("2026-02-30");
  assert.equal(impossibleDate.status, 2);
  assert.match(impossibleDate.stderr, /day is invalid/);
});
