import { test } from "node:test";
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  buildAcpxArgs,
  buildSessionSetupCommands,
  compactSessionLog,
  extractAssistantText,
  parseSessionIdentity,
  readSessionIdentityResult,
  runCommandWithFileCapture,
  selectPromptForSessionOutcome,
  sessionNameFromThreadKey,
  tailForLog,
} from "../acpx-adapter.js";

test("buildAcpxArgs puts global flags before the agent token for exec routes", () => {
  const args = buildAcpxArgs({
    agent: "codex",
    prompt: "review this change",
    permissionMode: "approve-reads",
    timeout: 90,
    isExecRoute: true,
  });

  assert.deepEqual(args, [
    "--approve-reads",
    "--format",
    "json",
    "--json-strict",
    "--suppress-reads",
    "--timeout",
    "90",
    "codex",
    "exec",
    "review this change",
  ]);
});

test("buildAcpxArgs uses prompt mode with a named session for persistent routes", () => {
  const args = buildAcpxArgs({
    agent: "claude",
    prompt: "apply the requested fix",
    permissionMode: "approve-all",
    sessionName: "pull_request-38-fix-pr-default",
    isExecRoute: false,
  });

  assert.deepEqual(args, [
    "--approve-all",
    "--format",
    "json",
    "--json-strict",
    "--suppress-reads",
    "claude",
    "prompt",
    "-s",
    "pull_request-38-fix-pr-default",
    "apply the requested fix",
  ]);
});

test("selectPromptForSessionOutcome uses continuation only after successful resume", () => {
  assert.equal(
    selectPromptForSessionOutcome({
      fullPrompt: "full route prompt",
      continuationPrompt: "latest request only",
      outcome: { kind: "resumed", resumedFromSessionId: "ses-123" },
    }),
    "latest request only",
  );

  assert.equal(
    selectPromptForSessionOutcome({
      fullPrompt: "full route prompt",
      continuationPrompt: "latest request only",
      outcome: { kind: "resume_fallback", resumedFromSessionId: "ses-123", error: "expired" },
    }),
    "full route prompt",
  );

  assert.equal(
    selectPromptForSessionOutcome({
      fullPrompt: "full route prompt",
      continuationPrompt: "latest request only",
      outcome: { kind: "fresh" },
    }),
    "full route prompt",
  );
});

test("selectPromptForSessionOutcome falls back to full prompt without continuation", () => {
  assert.equal(
    selectPromptForSessionOutcome({
      fullPrompt: "full route prompt",
      outcome: { kind: "resumed", resumedFromSessionId: "ses-123" },
    }),
    "full route prompt",
  );
});

test("buildSessionSetupCommands configures thought level and full-access mode for persistent sessions", () => {
  const commands = buildSessionSetupCommands({
    agent: "codex",
    sessionName: "issue-24-implement-default",
    thoughtLevel: "xhigh",
    permissionMode: "approve-all",
  });

  assert.deepEqual(commands, [
    {
      label: "set thought_level",
      args: ["codex", "set", "-s", "issue-24-implement-default", "thought_level", "xhigh"],
    },
    {
      label: "set-mode",
      args: ["codex", "set-mode", "-s", "issue-24-implement-default", "full-access"],
    },
  ]);
});

test("buildSessionSetupCommands sets full-access mode for all persistent sessions", () => {
  const commands = buildSessionSetupCommands({
    agent: "codex",
    sessionName: "pull_request-38-review-default",
    thoughtLevel: "high",
    permissionMode: "approve-all",
  });

  assert.deepEqual(commands, [
    {
      label: "set thought_level",
      args: ["codex", "set", "-s", "pull_request-38-review-default", "thought_level", "high"],
    },
    {
      label: "set-mode",
      args: ["codex", "set-mode", "-s", "pull_request-38-review-default", "full-access"],
    },
  ]);
});

test("buildSessionSetupCommands does nothing without a session and ignores blank thought level", () => {
  assert.deepEqual(
    buildSessionSetupCommands({
      agent: "codex",
      sessionName: undefined,
      thoughtLevel: "xhigh",
      permissionMode: "approve-all",
    }),
    [],
  );

  assert.deepEqual(
    buildSessionSetupCommands({
      agent: "codex",
      sessionName: "issue-24-answer-default",
      thoughtLevel: "   ",
      permissionMode: "approve-all",
    }),
    [
      {
        label: "set-mode",
        args: ["codex", "set-mode", "-s", "issue-24-answer-default", "full-access"],
      },
    ],
  );
});

test("buildSessionSetupCommands maps claude approve-all to bypassPermissions only", () => {
  const commands = buildSessionSetupCommands({
    agent: "claude",
    sessionName: "pull_request-81-review-default",
    thoughtLevel: "max",
    permissionMode: "approve-all",
  });

  assert.deepEqual(commands, [
    {
      label: "set-mode",
      args: ["claude", "set-mode", "-s", "pull_request-81-review-default", "bypassPermissions"],
    },
  ]);
});

test("buildSessionSetupCommands skips claude setup when not approve-all", () => {
  const commands = buildSessionSetupCommands({
    agent: "claude",
    sessionName: "pull_request-81-review-default",
    thoughtLevel: "max",
    permissionMode: "approve-reads",
  });

  assert.deepEqual(commands, []);
});

test("extractAssistantText returns the last message from a compacted log", () => {
  const log = [
    '{"type":"message","text":"Checking the repo."}',
    '{"type":"tool_call","name":"shell","status":"completed"}',
    '{"type":"message","text":"The answer is four."}',
    '{"type":"done","stopReason":"end_turn"}',
  ].join("\n");

  assert.equal(extractAssistantText(log), "The answer is four.");
});

test("extractAssistantText returns empty string when no messages exist", () => {
  const log = '{"type":"done","stopReason":"end_turn"}';
  assert.equal(extractAssistantText(log), "");
});

test("tailForLog leaves short values unchanged", () => {
  assert.equal(tailForLog("hello", 10), "hello");
});

test("tailForLog keeps the end of long values with a truncation marker", () => {
  const value = "abcdefghijklmnopqrstuvwxyz";
  assert.equal(
    tailForLog(value, 10),
    "[truncated 16 chars]\nqrstuvwxyz",
  );
});

test("runCommandWithFileCapture captures large stdout without a maxBuffer cap", () => {
  const size = 2 * 1024 * 1024;
  const result = runCommandWithFileCapture({
    command: process.execPath,
    args: ["-e", `process.stdout.write("x".repeat(${size}))`],
    cwd: process.cwd(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.length, size);
  assert.equal(result.stdout, "x".repeat(size));
});

test("runCommandWithFileCapture captures stderr and failing exit codes", () => {
  const result = runCommandWithFileCapture({
    command: process.execPath,
    args: ["-e", 'process.stderr.write("oops\\n"); process.exit(7);'],
    cwd: process.cwd(),
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "oops\n");
});

test("runCommandWithFileCapture treats signal-terminated processes as failures", () => {
  const result = runCommandWithFileCapture({
    command: process.execPath,
    args: ["-e", 'process.kill(process.pid, "SIGTERM")'],
    cwd: process.cwd(),
  });

  assert.equal(result.exitCode, 1);
});

test("compactSessionLog merges tokens and keeps structured events", () => {
  const ndjson = [
    '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}',
    '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{}}}',
    '{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}',
    '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"sess-123","models":{"currentModelId":"gpt-5.4/xhigh"}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"available_commands_update"}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Check"}}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ing."}}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","name":"shell","status":"running"}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","name":"shell","status":"completed"}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done."}}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"usage_update","used":5000,"size":100000}}}',
    '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
  ].join("\n");

  const lines = compactSessionLog(ndjson).trim().split("\n").map((l) => JSON.parse(l));

  assert.deepEqual(lines, [
    { type: "session", sessionId: "sess-123", model: "gpt-5.4/xhigh" },
    { type: "message", text: "Checking." },
    { type: "tool_call", name: "shell", status: "running" },
    { type: "tool_call_update", name: "shell", status: "completed" },
    { type: "message", text: "Done." },
    { type: "usage", used: 5000, size: 100000 },
    { type: "done", stopReason: "end_turn" },
  ]);
});

test("parseSessionIdentity reads canonical acpx json output", () => {
  const identity = parseSessionIdentity(JSON.stringify({
    acpxRecordId: "record-123",
    acpSessionId: "session-456",
    agentSessionId: "inner-789",
  }));

  assert.deepEqual(identity, {
    acpxRecordId: "record-123",
    acpxSessionId: "session-456",
  });
});

test("parseSessionIdentity reads alias fields from acpx metadata", () => {
  assert.deepEqual(
    parseSessionIdentity(JSON.stringify({ recordId: "record-123", sessionId: "session-456" })),
    {
      acpxRecordId: "record-123",
      acpxSessionId: "session-456",
    },
  );
  assert.deepEqual(
    parseSessionIdentity(JSON.stringify({ acpxRecordId: "record-123", acpxSessionId: "session-456" })),
    {
      acpxRecordId: "record-123",
      acpxSessionId: "session-456",
    },
  );
});

test("readSessionIdentityResult streams large acpx metadata through file capture", () => {
  const dir = mkdtempSync(join(tmpdir(), "acpx-identity-test-"));
  const oldPath = process.env.PATH;
  try {
    const acpxPath = join(dir, "acpx");
    writeFileSync(
      acpxPath,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ acpxRecordId: "record-123", acpSessionId: "session-456", messages: "x".repeat(2 * 1024 * 1024) }));\n`,
      "utf8",
    );
    chmodSync(acpxPath, 0o755);
    process.env.PATH = `${dir}${delimiter}${oldPath || ""}`;

    const result = readSessionIdentityResult("codex", "session-name", process.cwd());

    assert.deepEqual(result, {
      identity: {
        acpxRecordId: "record-123",
        acpxSessionId: "session-456",
      },
      error: "",
    });
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSessionIdentity returns null for incomplete payloads", () => {
  assert.equal(parseSessionIdentity(JSON.stringify({ acpxRecordId: "record-only" })), null);
  assert.equal(parseSessionIdentity("unknown: data"), null);
});

test("sessionNameFromThreadKey drops the repo prefix and keeps route identity", () => {
  assert.equal(
    sessionNameFromThreadKey("self-evolving/repo:pull_request:38:fix-pr:default"),
    "pull_request-38-fix-pr-default",
  );
});
