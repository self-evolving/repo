import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { strict as assert } from "node:assert";

function runPendingGate(prsJson: string, extraEnv: Record<string, string> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "pending-update-gate-"));
  const binDir = join(tempDir, "bin");
  const outputFile = join(tempDir, "outputs.txt");
  const responseFile = join(tempDir, "prs.json");
  const ghPath = join(binDir, "gh");
  mkdirSync(binDir);
  writeFileSync(responseFile, prsJson);
  writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"$1 $2 $3\" != \"pr list --repo\" ]; then",
      "  echo \"unexpected gh invocation: $*\" >&2",
      "  exit 1",
      "fi",
      "cat \"${GH_STUB_RESPONSE}\"",
    ].join("\n") + "\n",
  );
  chmodSync(ghPath, 0o755);

  const result = spawnSync("bash", ["scripts/resolve-pending-update-pr.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ALLOW_EXISTING_UPDATE_PR: "false",
      GH_TOKEN: "test-token",
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "self-evolving/repo",
      GH_STUB_RESPONSE: responseFile,
      PATH: `${binDir}:${process.env.PATH || ""}`,
      UPDATE_BRANCH_PREFIX: "agent/update-agent-infra-",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  const outputText = result.status === 0 ? readFileSync(outputFile, "utf8") : "";
  const payload = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { result, outputText, payload };
}

test("pending update PR gate skips same-repository update branches", () => {
  const { result, outputText, payload } = runPendingGate(
    JSON.stringify([
      {
        number: 123,
        url: "https://github.com/self-evolving/repo/pull/123",
        headRefName: "agent/update-agent-infra-20260503",
        isCrossRepository: false,
      },
    ]),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload.skip, true);
  assert.equal(payload.reason, "pending update PR exists");
  assert.equal(payload.prNumber, "123");
  assert.equal(payload.branch, "agent/update-agent-infra-20260503");
  assert.match(outputText, /skip<<[\s\S]*true/);
  assert.match(outputText, /pr_url<<[\s\S]*\/pull\/123/);
});

test("pending update PR gate ignores unrelated and cross-repository PRs", () => {
  const { result, payload } = runPendingGate(
    JSON.stringify([
      {
        number: 10,
        url: "https://github.com/self-evolving/repo/pull/10",
        headRefName: "agent/update-agent-infra-20260503",
        isCrossRepository: true,
      },
      {
        number: 11,
        url: "https://github.com/self-evolving/repo/pull/11",
        headRefName: "agent/implement-issue-27/codex-1",
        isCrossRepository: false,
      },
    ]),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload.skip, false);
  assert.equal(payload.reason, "no pending update PR");
});

test("pending update PR gate allows explicit force runs", () => {
  const { result, payload } = runPendingGate(
    JSON.stringify([
      {
        number: 123,
        url: "https://github.com/self-evolving/repo/pull/123",
        headRefName: "agent/update-agent-infra-20260503",
        isCrossRepository: false,
      },
    ]),
    { ALLOW_EXISTING_UPDATE_PR: "true" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload.skip, false);
  assert.equal(payload.reason, "pending update PR override enabled");
});
