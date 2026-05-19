import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

test("dispatch-agent-orchestrator defaults automation max rounds to 12", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-dispatch-orchestrator-"));
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

    const result = spawnSync("node", [".agent/dist/cli/dispatch-agent-orchestrator.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        FAKE_DISPATCH_PAYLOAD: payloadPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        DEFAULT_BRANCH: "main",
        SOURCE_ACTION: "orchestrate",
        SOURCE_CONCLUSION: "requested",
        TARGET_KIND: "issue",
        TARGET_NUMBER: "30",
        REQUESTED_BY: "lolipopshock",
        REQUEST_TEXT: "@sepo-agent /orchestrate",
        AUTOMATION_MODE: "agent",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(payloadPath));
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    assert.equal(payload.inputs.automation_max_rounds, "12");
    assert.equal(payload.inputs.automation_current_round, "1");
    assert.equal(payload.inputs.source_action, "orchestrate");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("dispatch-agent-orchestrator forwards review recommended next step", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-dispatch-orchestrator-"));
  try {
    const payloadPath = join(tempDir, "dispatch.json");
    const responsePath = join(tempDir, "response.md");
    writeFileSync(
      responsePath,
      [
        "## Recommended Next Step",
        "HUMAN_DECISION: Let self-approval decide whether the warnings are acceptable.",
        "",
        "## Final Verdict",
        "MINOR_ISSUES",
        "",
        "## Action Items",
        "- [ ] Optional polish that should not become fix-pr context.",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(tempDir, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "api" ] && [ "\${2-}" = "-X" ] && [ "\${3-}" = "POST" ]; then
  cat > "$FAKE_DISPATCH_PAYLOAD"
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, { encoding: "utf8", mode: 0o755 });

    const result = spawnSync("node", [".agent/dist/cli/dispatch-agent-orchestrator.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        FAKE_DISPATCH_PAYLOAD: payloadPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        DEFAULT_BRANCH: "main",
        SOURCE_ACTION: "review",
        RESPONSE_FILE: responsePath,
        TARGET_KIND: "pull_request",
        TARGET_NUMBER: "30",
        REQUESTED_BY: "lolipopshock",
        REQUEST_TEXT: "@sepo-agent /orchestrate",
        AUTOMATION_MODE: "heuristics",
        ORCHESTRATION_ENABLED: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(payloadPath));
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    assert.equal(payload.inputs.source_conclusion, "minor_issues");
    assert.equal(payload.inputs.source_recommended_next_step, "human_decision");
    assert.equal(payload.inputs.source_handoff_context, "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
