import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function runDispatchAgentOrchestrator(env: Record<string, string | undefined>, response?: string): {
  status: number | null;
  stderr: string;
  stdout: string;
  payload: Record<string, any> | null;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-dispatch-orchestrator-"));
  try {
    const payloadPath = join(tempDir, "dispatch.json");
    const responsePath = join(tempDir, "response.md");
    if (response !== undefined) {
      writeFileSync(responsePath, response, "utf8");
    }
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
        TARGET_KIND: "pull_request",
        TARGET_NUMBER: "30",
        REQUESTED_BY: "lolipopshock",
        REQUEST_TEXT: "@sepo-agent /orchestrate",
        AUTOMATION_MODE: "agent",
        RESPONSE_FILE: response === undefined ? undefined : responsePath,
        ...env,
      },
      encoding: "utf8",
    });

    const payload = existsSync(payloadPath) ? JSON.parse(readFileSync(payloadPath, "utf8")) : null;
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, payload };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("dispatch-agent-orchestrator defaults automation max rounds to 12", () => {
  const result = runDispatchAgentOrchestrator({
    SOURCE_ACTION: "orchestrate",
    SOURCE_CONCLUSION: "requested",
    TARGET_KIND: "issue",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = result.payload;
  assert.ok(payload);
  assert.equal(payload.inputs.automation_max_rounds, "12");
  assert.equal(payload.inputs.automation_current_round, "1");
  assert.equal(payload.inputs.source_action, "orchestrate");
});

test("dispatch-agent-orchestrator preserves SHIP with HUMAN_DECISION self-approval context", () => {
  const result = runDispatchAgentOrchestrator(
    {},
    [
      "## AI Review Synthesis",
      "",
      "## Recommended Next Step",
      "`HUMAN_DECISION`: the implementation is complete, but final approval needs product judgment.",
      "",
      "## Final Verdict",
      "SHIP",
    ].join("\n"),
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = result.payload;
  assert.ok(payload);
  assert.equal(payload.inputs.source_conclusion, "ship");
  assert.match(payload.inputs.source_handoff_context, /Final Verdict is SHIP but recommends HUMAN_DECISION/);
  assert.match(payload.inputs.source_handoff_context, /final approval needs product judgment/);
});

test("dispatch-agent-orchestrator converts non-SHIP HUMAN_DECISION to human stop conclusion", () => {
  const result = runDispatchAgentOrchestrator(
    {},
    [
      "## AI Review Synthesis",
      "",
      "## Recommended Next Step",
      "`HUMAN_DECISION`: remaining concerns are product judgment.",
      "",
      "## Final Verdict",
      "NEEDS_REWORK",
    ].join("\n"),
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = result.payload;
  assert.ok(payload);
  assert.equal(payload.inputs.source_conclusion, "human_decision");
  assert.equal(payload.inputs.source_handoff_context, "");
});
