import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assertSupportedLocalSessionInput,
  detectLocalSessionInputFormat,
  LOCAL_SESSION_TRACE_KIND,
  LOCAL_SESSION_TRACE_SCHEMA_VERSION,
  parseLocalSessionTrace,
  sanitizeLocalSessionMessageContent,
  serializeLocalSessionTrace,
  validateLocalSessionTrace,
} from "../local-session-trace.js";

const EXPORTED_AT = "2026-08-03T12:34:56.000Z";
const now = () => new Date(EXPORTED_AT);

test("parses and normalizes a canonical JSON trace", () => {
  const trace = parseLocalSessionTrace(JSON.stringify({
    kind: LOCAL_SESSION_TRACE_KIND,
    schema_version: LOCAL_SESSION_TRACE_SCHEMA_VERSION,
    exported_at: "2026-08-03T05:34:56-07:00",
    provenance: { source_format: "markdown", provider: "Codex" },
    messages: [
      {
        role: "user",
        content: "Keep this request\nOPENAI_API_KEY=sk-proj-abcdefghijklmnop",
        timestamp: "2026-08-03T05:30:00-07:00",
      },
      { role: "assistant", content: "Done" },
    ],
  }), { inputFormat: "json" });

  assert.equal(trace.exported_at, EXPORTED_AT);
  assert.deepEqual(trace.provenance, {
    source_format: "markdown",
    provider: "codex",
  });
  assert.equal(trace.messages[0].timestamp, "2026-08-03T12:30:00.000Z");
  assert.equal(trace.messages[0].content.includes("sk-proj-"), false);
  assert.match(trace.messages[0].content, /\[REDACTED credential\]/);
});

test("canonical traces reject fields outside the sanitized schema", () => {
  assert.throws(
    () => validateLocalSessionTrace({
      kind: LOCAL_SESSION_TRACE_KIND,
      schema_version: LOCAL_SESSION_TRACE_SCHEMA_VERSION,
      exported_at: EXPORTED_AT,
      provenance: { source_format: "jsonl", environment: { HOME: "/secret" } },
      messages: [{ role: "user", content: "hello" }],
    }),
    /provenance contains unsupported field: environment/,
  );

  assert.throws(
    () => validateLocalSessionTrace({
      kind: LOCAL_SESSION_TRACE_KIND,
      schema_version: LOCAL_SESSION_TRACE_SCHEMA_VERSION,
      exported_at: EXPORTED_AT,
      provenance: { source_format: "json" },
      messages: [{ role: "assistant", content: "hello", tool_payload: "secret" }],
    }),
    /messages\[0\] contains unsupported field: tool_payload/,
  );

  assert.throws(
    () => validateLocalSessionTrace({
      kind: LOCAL_SESSION_TRACE_KIND,
      schema_version: LOCAL_SESSION_TRACE_SCHEMA_VERSION,
      exported_at: EXPORTED_AT,
      provenance: { source_format: "json" },
      messages: [{ role: "assistant", content: "hello", timestamp: "yesterday" }],
    }),
    /timestamp must be an ISO-8601 timestamp/,
  );
  assert.throws(
    () => validateLocalSessionTrace({
      kind: LOCAL_SESSION_TRACE_KIND,
      schema_version: LOCAL_SESSION_TRACE_SCHEMA_VERSION,
      exported_at: "2026-08-03T12:34:56",
      provenance: { source_format: "json" },
      messages: [{ role: "assistant", content: "hello" }],
    }),
    /exported_at must be an ISO-8601 timestamp/,
  );
});

test("canonical JSONL round-trips without tool or metadata records", () => {
  const original = parseLocalSessionTrace(
    "## User\nQuestion\n\n## Assistant\nAnswer",
    { inputFormat: "markdown", provider: "codex", now },
  );
  const jsonl = serializeLocalSessionTrace(original, "jsonl");
  const records = jsonl.trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(records[0].record_type, "trace");
  assert.deepEqual(records.slice(1).map((record) => record.record_type), [
    "message",
    "message",
  ]);
  assert.deepEqual(
    parseLocalSessionTrace(jsonl, { inputFormat: "jsonl" }),
    original,
  );
});

test("extracts only user and assistant text from Codex JSONL", () => {
  const input = [
    {
      timestamp: "2026-08-03T10:00:00Z",
      type: "session_meta",
      payload: { cwd: "/private/work", environment: { SECRET: "metadata-secret" } },
    },
    {
      timestamp: "2026-08-03T10:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer-secret" }],
      },
    },
    {
      timestamp: "2026-08-03T10:00:02Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "Fix the parser\n<environment_context>HOME=/private/work</environment_context>",
        }],
      },
    },
    {
      timestamp: "2026-08-03T10:00:03Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "<environment_snapshot>RAW_TOKEN=metadata-secret</environment_snapshot>",
        }],
      },
    },
    {
      timestamp: "2026-08-03T10:00:04Z",
      type: "response_item",
      payload: { type: "custom_tool_call_output", output: "raw-tool-secret" },
    },
    {
      timestamp: "2026-08-03T10:00:05Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: "Finished. Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        }],
      },
    },
  ].map((record) => JSON.stringify(record)).join("\n");

  const trace = parseLocalSessionTrace(input, { inputFormat: "jsonl", now });
  const serialized = serializeLocalSessionTrace(trace);

  assert.equal(trace.provenance.provider, "codex");
  assert.deepEqual(trace.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(trace.messages[0].content, "Fix the parser");
  assert.match(trace.messages[1].content, /Bearer \[REDACTED credential\]/);
  for (const excluded of [
    "/private/work",
    "metadata-secret",
    "developer-secret",
    "raw-tool-secret",
    "custom_tool_call_output",
  ]) {
    assert.equal(serialized.includes(excluded), false, `trace leaked ${excluded}`);
  }
});

test("extracts Claude text blocks and drops thinking, tools, results, and snapshots", () => {
  const input = [
    { type: "file-history-snapshot", snapshot: { content: "snapshot-secret" } },
    {
      type: "user",
      timestamp: "2026-08-03T11:00:00Z",
      message: { role: "user", content: "Please inspect this" },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "private-reasoning" }],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I checked it." },
          { type: "tool_use", name: "shell", input: { command: "tool-secret" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "tool-result-secret" }],
      },
    },
  ].map((record) => JSON.stringify(record)).join("\n");

  const trace = parseLocalSessionTrace(input, { inputFormat: "jsonl", now });
  const serialized = serializeLocalSessionTrace(trace);

  assert.equal(trace.provenance.provider, "claude");
  assert.deepEqual(trace.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Please inspect this" },
    { role: "assistant", content: "I checked it." },
  ]);
  for (const excluded of [
    "snapshot-secret",
    "private-reasoning",
    "tool-secret",
    "tool-result-secret",
  ]) {
    assert.equal(serialized.includes(excluded), false, `trace leaked ${excluded}`);
  }
});

test("drops Claude meta and sidechain records before message extraction", () => {
  const input = [
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "synthetic-control-text" },
    },
    {
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", content: "child-agent-text" },
    },
    {
      type: "user",
      isMeta: false,
      isSidechain: false,
      message: { role: "user", content: "Real request" },
    },
  ].map((record) => JSON.stringify(record)).join("\n");

  const trace = parseLocalSessionTrace(input, { inputFormat: "jsonl", now });

  assert.equal(trace.provenance.provider, "claude");
  assert.deepEqual(trace.messages, [{ role: "user", content: "Real request" }]);
  assert.equal(serializeLocalSessionTrace(trace).includes("synthetic-control-text"), false);
  assert.equal(serializeLocalSessionTrace(trace).includes("child-agent-text"), false);
});

test("generic JSON message lists retain text roles and ignore privileged roles", () => {
  const trace = parseLocalSessionTrace(JSON.stringify({
    environment: { TOKEN: "metadata-secret" },
    messages: [
      { role: "system", content: "system-secret" },
      { role: "user", content: "Question" },
      { type: "tool_result", role: "user", content: "raw-tool-secret" },
      { role: "assistant", content: [{ type: "text", text: "Answer" }] },
      { role: "assistant", content: [{ type: "thinking", text: "reasoning-secret" }] },
    ],
  }), { inputFormat: "json", now });

  assert.deepEqual(trace.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Question" },
    { role: "assistant", content: "Answer" },
  ]);
  const serialized = serializeLocalSessionTrace(trace);
  assert.equal(serialized.includes("secret"), false);
});

test("Markdown and text parsers preserve role blocks and discard unsafe roles", () => {
  const markdown = [
    "# Transcript",
    "",
    "## System",
    "system-secret",
    "",
    "## User",
    "Please keep this code example:",
    "```text",
    "Assistant: this line stays in the user message",
    "```",
    "PASSWORD=hunter2",
    "",
    "## Environment snapshot",
    "environment-secret",
    "",
    "## Tool result",
    "raw-tool-secret",
    "",
    "## Assistant: Done",
  ].join("\n");
  const markdownTrace = parseLocalSessionTrace(markdown, {
    inputFormat: "markdown",
    now,
  });

  assert.deepEqual(markdownTrace.messages.map((message) => message.role), [
    "user",
    "assistant",
  ]);
  assert.match(markdownTrace.messages[0].content, /Assistant: this line stays/);
  assert.match(markdownTrace.messages[0].content, /PASSWORD=\[REDACTED credential\]/);
  assert.equal(serializeLocalSessionTrace(markdownTrace).includes("raw-tool-secret"), false);
  assert.equal(serializeLocalSessionTrace(markdownTrace).includes("system-secret"), false);
  assert.equal(serializeLocalSessionTrace(markdownTrace).includes("environment-secret"), false);

  const textTrace = parseLocalSessionTrace(
    "Human: Question\nAI: Answer\nDeveloper: hidden\nUser: Follow-up",
    { inputFormat: "text", now },
  );
  assert.deepEqual(textTrace.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Question" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "Follow-up" },
  ]);
});

test("Markdown parsing keeps shorter fences inside four-backtick blocks", () => {
  const trace = parseLocalSessionTrace([
    "## User",
    "Please keep this nested example:",
    "````markdown",
    "```text",
    "Assistant: example response",
    "```",
    "Tool: example output",
    "````",
    "## Assistant",
    "Actual response",
  ].join("\n"), { inputFormat: "markdown", now });

  assert.deepEqual(trace.messages.map((message) => message.role), ["user", "assistant"]);
  assert.match(trace.messages[0].content, /Assistant: example response/);
  assert.match(trace.messages[0].content, /Tool: example output/);
  assert.equal(trace.messages[1].content, "Actual response");
});

test("unlabelled text becomes one user message and auto detection honors formats", () => {
  const trace = parseLocalSessionTrace("A plain request", {
    inputFormat: "text",
    now,
  });
  assert.deepEqual(trace.messages, [{ role: "user", content: "A plain request" }]);
  assert.equal(detectLocalSessionInputFormat("{}", "session.json"), "json");
  assert.equal(detectLocalSessionInputFormat("{}\n{}", ""), "jsonl");
  assert.equal(detectLocalSessionInputFormat("## User\nhello", ""), "markdown");
  assert.equal(detectLocalSessionInputFormat("hello", ""), "text");
});

test("credential and embedded payload redaction never returns the original values", () => {
  const content = sanitizeLocalSessionMessageContent([
    "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
    '"api_key": "sk-proj-abcdefghijklmnop"',
    "Authorization: Basic dXNlcjpwYXNz",
    "https://alice:password@example.com/path",
    "<tool_result>raw-tool-secret</tool_result>",
    "<environment_context>HOME=/secret</environment_context>",
    "-----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----",
  ].join("\n"));

  for (const excluded of [
    "ghp_",
    "sk-proj-",
    "dXNlcjpwYXNz",
    "alice:password",
    "raw-tool-secret",
    "HOME=/secret",
    "private-key-secret",
  ]) {
    assert.equal(content.includes(excluded), false, `content leaked ${excluded}`);
  }
  assert.match(content, /\[REDACTED credential\]/);
});

test("sensitive block stripping handles adversarial unclosed tags in linear passes", () => {
  const content = `visible${"<environment_context>".repeat(20_000)}secret`;

  assert.equal(sanitizeLocalSessionMessageContent(content), "visible");
  assert.equal(
    sanitizeLocalSessionMessageContent("visible<tool_result payload without a close"),
    "visible",
  );
});

test("archive extensions, archive magic, and binary inputs are rejected", () => {
  assert.throws(
    () => assertSupportedLocalSessionInput("session.tgz", Buffer.from("plain text")),
    /Archive inputs are not supported/,
  );
  assert.throws(
    () => assertSupportedLocalSessionInput(
      "session.data",
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]),
    ),
    /Archive inputs are not supported/,
  );
  assert.throws(
    () => assertSupportedLocalSessionInput("session.data", Buffer.from([0x41, 0x00, 0x42])),
    /Binary local-session inputs are not supported/,
  );
  assert.throws(
    () => assertSupportedLocalSessionInput("session.data", Buffer.from([0xc3, 0x28])),
    /Binary local-session inputs are not supported/,
  );
});

test("malformed structured inputs fail without falling back to prose", () => {
  assert.throws(
    () => parseLocalSessionTrace('{"role":"user"', { inputFormat: "auto", now }),
    /not valid JSON or JSONL/,
  );
  assert.throws(
    () => parseLocalSessionTrace('{"type":"tool","payload":"secret"}', {
      inputFormat: "json",
      now,
    }),
    /No user or assistant text messages/,
  );
  assert.throws(
    () => parseLocalSessionTrace('{"role":"user"}\nnot-json', {
      inputFormat: "jsonl",
      now,
    }),
    /Invalid JSONL record on line 2/,
  );
});
