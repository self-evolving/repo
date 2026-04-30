import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

test("dispatch-agent-implement forwards stacked PR base inputs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-dispatch-implement-"));
  try {
    const payloadPath = join(tempDir, "dispatch.json");
    writeFileSync(join(tempDir, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "api" ] && [ "\${2-}" = "-X" ] && [ "\${3-}" = "POST" ]; then
  cat > "$FAKE_DISPATCH_PAYLOAD"
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, { encoding: "utf8", mode: 0o755 });

    const result = spawnSync("node", [".agent/dist/cli/dispatch-agent-implement.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        FAKE_DISPATCH_PAYLOAD: payloadPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        DEFAULT_BRANCH: "main",
        ISSUE_NUMBER: "30",
        REQUESTED_BY: "lolipopshock",
        BASE_BRANCH: "agent/parent-branch",
        BASE_PR: "",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.ok(existsSync(payloadPath));
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    assert.equal(payload.inputs.base_branch, "agent/parent-branch");
    assert.equal(payload.inputs.base_pr, "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
