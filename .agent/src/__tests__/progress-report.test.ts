import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  createProgressReporterState,
  finalizeProgressReporter,
  parseProgressReporterConfig,
  progressReporterTick,
  readStreamTail,
  type ProgressReporterConfig,
  type ProgressReporterDeps,
} from "../cli/progress-report.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ndjsonLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function toolEvent(name: string, status = "completed"): string {
  return ndjsonLine({
    params: {
      update: {
        sessionUpdate: "tool_call",
        name,
        status,
      },
    },
  });
}

function messageEvent(text: string): string {
  return ndjsonLine({
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function doneEvent(): string {
  return ndjsonLine({
    jsonrpc: "2.0",
    id: 2,
    result: { stopReason: "end_turn" },
  });
}

function baseConfig(overrides: Partial<ProgressReporterConfig> = {}): ProgressReporterConfig {
  return {
    streamFile: "/tmp/progress.ndjson",
    repo: "self-evolving/repo",
    targetKind: "issue",
    targetNumber: 10,
    requester: "alice",
    route: "implement",
    runId: "123",
    pollIntervalMs: 1_000,
    cancelEnabled: true,
    maxStreamBytes: 1024 * 1024,
    ...overrides,
  };
}

function createHarness(options: {
  stream?: string;
  now?: number;
  reactions?: { content: string; user: string }[];
  createError?: Error;
  updateError?: Error;
  readError?: Error;
} = {}): {
  deps: ProgressReporterDeps;
  calls: {
    creates: string[];
    updates: string[];
    cancels: string[];
    logs: string[];
    reactionLists: number;
  };
  setStream: (stream: string) => void;
  setNow: (now: number) => void;
  setUpdateError: (error?: Error) => void;
  setReadError: (error?: Error) => void;
} {
  let stream = options.stream ?? "";
  let now = options.now ?? 0;
  let updateError = options.updateError;
  let readError = options.readError;
  const calls = {
    creates: [] as string[],
    updates: [] as string[],
    cancels: [] as string[],
    logs: [] as string[],
    reactionLists: 0,
  };

  const deps: ProgressReporterDeps = {
    now: () => now,
    readStream: () => {
      if (readError) throw readError;
      return stream;
    },
    createComment: (_repo, _issueNumber, body) => {
      if (options.createError) throw options.createError;
      calls.creates.push(body);
      return "999";
    },
    updateComment: (_repo, _commentId, body) => {
      calls.updates.push(body);
      if (updateError) throw updateError;
    },
    listReactions: () => {
      calls.reactionLists += 1;
      return options.reactions ?? [];
    },
    findAuthorizedCancel: (_repo, reactions, requester) => {
      const match = reactions.find(
        (reaction) => reaction.content === "THUMBS_DOWN" && reaction.user.toLowerCase() === requester.toLowerCase(),
      );
      return match
        ? { content: "THUMBS_DOWN", user: match.user, authorization: "REQUESTER" }
        : null;
    },
    invokeCancel: (reaction) => {
      calls.cancels.push(reaction.user);
    },
    log: (message) => {
      calls.logs.push(message);
    },
  };

  return {
    deps,
    calls,
    setStream: (next) => {
      stream = next;
    },
    setNow: (next) => {
      now = next;
    },
    setUpdateError: (error) => {
      updateError = error;
    },
    setReadError: (error) => {
      readError = error;
    },
  };
}

test("first tick creates one starting comment and suppresses identical patches", () => {
  const config = baseConfig({ cancelEnabled: false });
  const state = createProgressReporterState(0);
  const harness = createHarness({ stream: "", now: 0 });

  const first = progressReporterTick(config, state, harness.deps);
  const second = progressReporterTick(config, state, harness.deps);

  assert.equal(first.created, true);
  assert.equal(first.shouldContinue, true);
  assert.equal(second.created, false);
  assert.equal(second.patched, false);
  assert.equal(harness.calls.creates.length, 1);
  assert.match(harness.calls.creates[0], /Starting…/);
  assert.deepEqual(harness.calls.updates, []);
});

test("stream growth patches the existing progress comment", () => {
  const config = baseConfig({ cancelEnabled: false });
  const state = createProgressReporterState(0);
  const harness = createHarness({ stream: "", now: 0 });

  progressReporterTick(config, state, harness.deps);
  harness.setStream(`${toolEvent("Read")}${messageEvent("Checking files.")}`);

  const result = progressReporterTick(config, state, harness.deps);

  assert.equal(result.patched, true);
  assert.equal(harness.calls.creates.length, 1);
  assert.equal(harness.calls.updates.length, 1);
  assert.match(harness.calls.updates[0], /- 📖 Read \(completed\)/);
  assert.match(harness.calls.updates[0], /Checking files\./);
});

test("terminal stream completion finalizes with a collapsed body and stops", () => {
  const config = baseConfig({ cancelEnabled: false });
  const state = createProgressReporterState(0);
  const harness = createHarness({ stream: "", now: 0 });

  progressReporterTick(config, state, harness.deps);
  harness.setStream(`${toolEvent("Write")}${messageEvent("Done.")}${doneEvent()}`);
  harness.setNow(5_000);

  const result = progressReporterTick(config, state, harness.deps);

  assert.equal(result.finalized, true);
  assert.equal(result.shouldContinue, false);
  assert.equal(state.finalized, true);
  assert.equal(harness.calls.updates.length, 1);
  assert.match(harness.calls.updates[0], /### Sepo finished — implement · 5s · 2 steps/);
  assert.match(harness.calls.updates[0], /<details>\n<summary>Activity<\/summary>/);
});

test("signal-style finalization patches a final body and exits the state machine", () => {
  const config = baseConfig({ cancelEnabled: false });
  const state = createProgressReporterState(0);
  const harness = createHarness({ stream: toolEvent("Grep"), now: 0 });

  progressReporterTick(config, state, harness.deps);
  harness.setNow(2_000);
  const patched = finalizeProgressReporter(config, state, harness.deps);

  assert.equal(patched, true);
  assert.equal(state.finalized, true);
  assert.equal(state.stopped, true);
  assert.equal(harness.calls.updates.length, 1);
  assert.match(harness.calls.updates[0], /### Sepo finished — implement · 2s · 1 step/);
});

test("authorized thumbs-down invokes the cancel path at most once", () => {
  const config = baseConfig({ cancelEnabled: true });
  const state = createProgressReporterState(0);
  const harness = createHarness({
    stream: "",
    now: 0,
    reactions: [{ content: "THUMBS_DOWN", user: "alice" }],
  });

  const first = progressReporterTick(config, state, harness.deps);
  const second = progressReporterTick(config, state, harness.deps);

  assert.equal(first.cancelInvoked, true);
  assert.equal(second.cancelInvoked, false);
  assert.deepEqual(harness.calls.cancels, ["alice"]);
  assert.equal(harness.calls.reactionLists, 1);
});

test("disabled cancellation ignores authorized thumbs-down reactions", () => {
  const config = baseConfig({ cancelEnabled: false });
  const state = createProgressReporterState(0);
  const harness = createHarness({
    stream: "",
    now: 0,
    reactions: [{ content: "THUMBS_DOWN", user: "alice" }],
  });

  const result = progressReporterTick(config, state, harness.deps);

  assert.equal(result.cancelInvoked, false);
  assert.deepEqual(harness.calls.cancels, []);
  assert.equal(harness.calls.reactionLists, 0);
});

test("comment create failure stops the reporter without throwing", () => {
  const config = baseConfig();
  const state = createProgressReporterState(0);
  const harness = createHarness({ createError: new Error("create failed") });

  const result = progressReporterTick(config, state, harness.deps);

  assert.equal(result.shouldContinue, false);
  assert.equal(state.stopped, true);
  assert.deepEqual(harness.calls.updates, []);
  assert.deepEqual(harness.calls.cancels, []);
  assert.match(harness.calls.logs.join("\n"), /create failed/);
});

test("patch errors are swallowed and retried on a later tick", () => {
  const config = baseConfig({ cancelEnabled: false });
  const state = createProgressReporterState(0);
  const harness = createHarness({ stream: "", now: 0, updateError: new Error("rate limited") });

  progressReporterTick(config, state, harness.deps);
  harness.setStream(toolEvent("Bash"));

  const failedPatch = progressReporterTick(config, state, harness.deps);
  harness.setUpdateError(undefined);
  const retriedPatch = progressReporterTick(config, state, harness.deps);

  assert.equal(failedPatch.shouldContinue, true);
  assert.equal(failedPatch.patched, false);
  assert.equal(retriedPatch.patched, true);
  assert.equal(harness.calls.updates.length, 2);
  assert.match(harness.calls.logs.join("\n"), /rate limited/);
});

test("stream read errors reuse the last good stream and keep running", () => {
  const config = baseConfig({ cancelEnabled: false });
  const state = createProgressReporterState(0);
  const harness = createHarness({ stream: toolEvent("Read"), now: 0 });

  progressReporterTick(config, state, harness.deps);
  harness.setReadError(new Error("stream unavailable"));

  const result = progressReporterTick(config, state, harness.deps);

  assert.equal(result.shouldContinue, true);
  assert.equal(result.patched, false);
  assert.match(harness.calls.logs.join("\n"), /stream unavailable/);
});

test("parseProgressReporterConfig accepts issue and pull request targets", () => {
  const issueConfig = parseProgressReporterConfig({
    AGENT_PROGRESS_STREAM_FILE: "/tmp/progress",
    GITHUB_REPOSITORY: "self-evolving/repo",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "10",
    REQUESTED_BY: "alice",
    ROUTE: "implement",
    GITHUB_RUN_ID: "123",
    AGENT_PROGRESS_CANCEL_ENABLED: "true",
  });
  const prConfig = parseProgressReporterConfig({
    AGENT_PROGRESS_STREAM_FILE: "/tmp/progress",
    REPO_SLUG: "self-evolving/repo",
    TARGET_KIND: "pr",
    TARGET_NUMBER: "11",
  });

  assert.equal(issueConfig?.cancelEnabled, true);
  assert.equal(issueConfig?.targetKind, "issue");
  assert.equal(issueConfig?.pollIntervalMs, 10_000);
  assert.equal(prConfig?.targetKind, "pull_request");
  assert.equal(prConfig?.targetNumber, 11);
});

test("parseProgressReporterConfig rejects sub-5s poll intervals", () => {
  const tooFast = parseProgressReporterConfig({
    AGENT_PROGRESS_STREAM_FILE: "/tmp/progress",
    GITHUB_REPOSITORY: "self-evolving/repo",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "10",
    AGENT_PROGRESS_POLL_INTERVAL_MS: "4999",
  });
  const allowed = parseProgressReporterConfig({
    AGENT_PROGRESS_STREAM_FILE: "/tmp/progress",
    GITHUB_REPOSITORY: "self-evolving/repo",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "10",
    AGENT_PROGRESS_POLL_INTERVAL_MS: "5000",
  });

  assert.equal(tooFast?.pollIntervalMs, 10_000);
  assert.equal(allowed?.pollIntervalMs, 5_000);
});

test("readStreamTail returns only the configured tail bytes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "progress-report-tail-"));
  try {
    const streamPath = join(tempDir, "stream.ndjson");
    writeFileSync(streamPath, "first\nsecond\nthird\n", "utf8");

    assert.equal(readStreamTail(streamPath, 6), "third\n");
    assert.equal(readStreamTail(join(tempDir, "missing"), 6), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
