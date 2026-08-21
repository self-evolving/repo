import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  createIssueComment,
  deleteIssueComment,
  dispatchWorkflow,
  fetchIssueCommentBody,
  updateIssueComment,
} from "../github.js";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755 });
}

test("createIssueComment posts to issue comments and returns the comment id", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-create-issue-comment-"));
  const originalPath = process.env.PATH;

  try {
    const binDir = join(tempDir, "bin");
    const argsPath = join(tempDir, "args");
    mkdirSync(binDir, { recursive: true });

    writeExecutable(join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `args_path=${JSON.stringify(argsPath)}`,
      "printf '%s\\0' \"$@\" > \"$args_path\"",
      "if [[ \"$1\" == \"api\" && \"$2\" == \"--method\" && \"$3\" == \"POST\" && \"$4\" == \"repos/self-evolving/repo/issues/42/comments\" ]]; then",
      "  printf '123456\\n'",
      "  exit 0",
      "fi",
      "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
      "exit 1",
      "",
    ].join("\n"));

    process.env.PATH = `${binDir}:${originalPath || ""}`;

    const id = createIssueComment("self-evolving/repo", 42, "hello body");
    const args = readFileSync(argsPath, "utf8").split("\0").filter(Boolean);

    assert.equal(id, "123456");
    assert.deepEqual(args, [
      "api",
      "--method",
      "POST",
      "repos/self-evolving/repo/issues/42/comments",
      "-f",
      "body=hello body",
      "--jq",
      ".id",
    ]);
  } finally {
    process.env.PATH = originalPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("progress comment helpers use an explicit token without replacing ambient auth", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-progress-comment-token-"));
  const originalPath = process.env.PATH;
  const originalGhToken = process.env.GH_TOKEN;

  try {
    const binDir = join(tempDir, "bin");
    const logPath = join(tempDir, "gh.log");
    mkdirSync(binDir, { recursive: true });

    writeExecutable(join(binDir, "gh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `log_path=${JSON.stringify(logPath)}`,
      "printf '%s\\t%s\\n' \"$GH_TOKEN\" \"$*\" >> \"$log_path\"",
      "if [[ \"$1\" == \"api\" && \"$2\" == \"repos/self-evolving/repo/issues/comments/123\" ]]; then",
      "  printf 'progress body\\n'",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == \"api\" && \"$2\" == \"--method\" && ( \"$3\" == \"PATCH\" || \"$3\" == \"DELETE\" ) ]]; then",
      "  exit 0",
      "fi",
      "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
      "exit 1",
      "",
    ].join("\n"));

    process.env.PATH = `${binDir}:${originalPath || ""}`;
    process.env.GH_TOKEN = "resolved-app-token";

    assert.equal(
      fetchIssueCommentBody("self-evolving/repo", 123, "workflow-token"),
      "progress body\n",
    );
    updateIssueComment("self-evolving/repo", 123, "final body", "workflow-token");
    deleteIssueComment("self-evolving/repo", 123, "workflow-token");

    const log = readFileSync(logPath, "utf8").trim().split(/\r?\n/);
    assert.deepEqual(log, [
      "workflow-token\tapi repos/self-evolving/repo/issues/comments/123 --jq .body",
      "workflow-token\tapi --method PATCH repos/self-evolving/repo/issues/comments/123 -f body=final body",
      "workflow-token\tapi --method DELETE repos/self-evolving/repo/issues/comments/123",
    ]);
    assert.equal(process.env.GH_TOKEN, "resolved-app-token");
  } finally {
    process.env.PATH = originalPath;
    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

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
