import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function runCli(env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/prepare-add-rubrics-proposal.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });
}

function readOutputValue(path: string, name: string): string {
  const text = readFileSync(path, "utf8");
  const match = text.match(new RegExp(`${name}<<([^\\n]+)\\n([\\s\\S]*?)\\n\\1`));
  return match ? match[2] : "";
}

test("prepare add-rubrics proposal derives a stable branch from request context", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "add-rubrics-proposal-"));

  try {
    const firstOutput = join(tempDir, "first-output.txt");
    const secondOutput = join(tempDir, "second-output.txt");
    const env = {
      GITHUB_OUTPUT: firstOutput,
      GH_TOKEN: "",
      GITHUB_REPOSITORY: "",
      REQUEST_TEXT: "@sepo-agent /add-rubrics prefer concise summaries",
      REQUESTED_BY: "lolipopshock",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "381",
    };

    const first = runCli(env);
    const second = runCli({ ...env, GITHUB_OUTPUT: secondOutput });

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);

    const firstBranch = readOutputValue(firstOutput, "branch");
    const secondBranch = readOutputValue(secondOutput, "branch");
    assert.equal(firstBranch, secondBranch);
    assert.match(firstBranch, /^agent\/add-rubrics-issue-381\/request-[0-9a-f]{12}$/);
    assert.equal(readOutputValue(firstOutput, "branch_lease_oid"), "");
    assert.doesNotMatch(firstBranch, /run_id/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
