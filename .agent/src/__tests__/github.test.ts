import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { dispatchWorkflow } from "../github.js";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755 });
}

test("dispatchWorkflow retries without inputs unsupported by the live workflow schema", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-dispatch-workflow-"));
  const originalPath = process.env.PATH;

  try {
    const binDir = join(tempDir, "bin");
    const payloadDir = join(tempDir, "payloads");
    const countPath = join(tempDir, "count");
    const logPath = join(tempDir, "gh.log");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(payloadDir, { recursive: true });

    writeExecutable(join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `count_path=${JSON.stringify(countPath)}`,
      `payload_dir=${JSON.stringify(payloadDir)}`,
      `log_path=${JSON.stringify(logPath)}`,
      "count=0",
      "if [[ -f \"$count_path\" ]]; then count=$(cat \"$count_path\"); fi",
      "count=$((count + 1))",
      "printf '%s' \"$count\" > \"$count_path\"",
      "printf '%s\\n' \"$*\" >> \"$log_path\"",
      "cat > \"$payload_dir/payload-$count.json\"",
      "if [[ \"$count\" == \"1\" ]]; then",
      "  printf '%s\\n' '{\"message\":\"Unexpected inputs provided: [\\\"target_kind\\\", \\\"access_policy\\\"]\"}'",
      "  printf '%s\\n' 'gh: Unexpected inputs provided: [\"target_kind\", \"access_policy\"]' >&2",
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"));

    process.env.PATH = `${binDir}:${originalPath || ""}`;

    dispatchWorkflow("self-evolving/repo", "agent-orchestrator.yml", "main", {
      access_policy: "{}",
      source_action: "fix-pr",
      target_kind: "pull_request",
      target_number: "20",
    });

    const firstPayload = JSON.parse(readFileSync(join(payloadDir, "payload-1.json"), "utf8"));
    const retryPayload = JSON.parse(readFileSync(join(payloadDir, "payload-2.json"), "utf8"));
    const log = readFileSync(logPath, "utf8").trim().split(/\r?\n/);

    assert.equal(log.length, 2);
    assert.equal(firstPayload.inputs.target_kind, "pull_request");
    assert.equal(firstPayload.inputs.access_policy, "{}");
    assert.equal(retryPayload.ref, "main");
    assert.deepEqual(retryPayload.inputs, {
      source_action: "fix-pr",
      target_number: "20",
    });
  } finally {
    process.env.PATH = originalPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
