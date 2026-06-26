import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildProgressViewModel,
  countProgressSteps,
  progressMarker,
  renderCancelled,
  renderFinal,
  renderRunning,
} from "../progress-render.js";

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

function toolUpdateEvent(name: string, status = "completed"): string {
  return ndjsonLine({
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        name,
        status,
      },
    },
  });
}

function titledToolEvent(name: string, title: string, status = "completed"): string {
  return ndjsonLine({
    params: {
      update: {
        sessionUpdate: "tool_call",
        name,
        title,
        status,
      },
    },
  });
}

function correlatedToolEvent(
  sessionUpdate: "tool_call" | "tool_call_update",
  toolCallId: string,
  fields: { name?: string; title?: string; status?: string },
): string {
  return ndjsonLine({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate,
        toolCallId,
        ...fields,
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

test("renders empty running progress as starting with marker", () => {
  const model = buildProgressViewModel(" \n", {
    runId: "123",
    route: "implement",
    elapsedMs: 0,
  });

  assert.equal(model.stepCount, 0);
  assert.deepEqual(model.recentActivity, []);

  const body = renderRunning(model);
  assert.match(body, /Sepo is working — implement · 0s · 0 steps/);
  assert.match(body, /Starting…/);
  assert.match(body, /<!-- sepo-progress:run-123 -->/);
});

test("derives friendly running progress from tools and messages", () => {
  const tail = [
    toolEvent("Read"),
    toolEvent("Edit"),
    toolEvent("Bash", "running"),
    toolEvent("Grep"),
    messageEvent("Checking the implementation shape."),
  ].join("");
  const model = buildProgressViewModel(tail, {
    runId: "456",
    route: "fix-pr",
    elapsedMs: 192_000,
  });

  assert.equal(model.stepCount, 5);
  assert.equal(model.lastMessage, "Checking the implementation shape.");
  assert.deepEqual(
    model.recentActivity.map((item) => item.label),
    ["📖 Read", "✏️ Edited", "💻 Ran", "🔍 Searched", "💬 Message"],
  );

  const body = renderRunning(model);
  assert.match(body, /Sepo is working — fix-pr · 3m12s · 5 steps/);
  assert.match(body, /- 📖 Read \(completed\)/);
  assert.match(body, /- ✏️ Edited `Edit` \(completed\)/);
  assert.match(body, /- 💻 Ran `Bash` \(running\)/);
  assert.match(body, /- 🔍 Searched `Grep` \(completed\)/);
  assert.match(body, /Last message\n> Checking the implementation shape\./);
});

test("ignores malformed and partial trailing lines without throwing", () => {
  const tail = `${toolEvent("Read")}not json\n{"params":{"update":{"sessionUpdate":"tool_call"`;

  const model = buildProgressViewModel(tail, {
    runId: "789",
    elapsedMs: 1_000,
  });

  assert.equal(model.stepCount, 1);
  assert.equal(model.recentActivity[0]?.label, "📖 Read");
  assert.doesNotThrow(() => renderRunning(model));
});

test("caps recent activity while preserving total step count", () => {
  const tail = [
    toolEvent("Read"),
    toolEvent("Edit"),
    toolEvent("Bash"),
    toolEvent("Grep"),
  ].join("");
  const model = buildProgressViewModel(tail, {
    runId: "cap",
    elapsedMs: 1_000,
    recentActivityLimit: 2,
  });

  assert.equal(model.stepCount, 4);
  assert.deepEqual(
    model.recentActivity.map((item) => item.label),
    ["💻 Ran", "🔍 Searched"],
  );
});

test("uses explicit total step count while rendering tail activity", () => {
  const model = buildProgressViewModel(toolEvent("Bash"), {
    runId: "tail-count",
    elapsedMs: 1_000,
    totalStepCount: 9,
  });

  assert.equal(model.stepCount, 9);
  assert.deepEqual(
    model.recentActivity.map((item) => item.label),
    ["💻 Ran"],
  );
  assert.match(renderRunning(model), /Sepo is working — 1s · 9 steps/);
});

test("counts collapsed logical progress steps from a full stream", () => {
  const tail = [
    correlatedToolEvent("tool_call", "call-1", {
      name: "tool_1",
      title: "Read .agent/src/progress-render.ts",
      status: "running",
    }),
    correlatedToolEvent("tool_call_update", "call-1", {
      status: "completed",
    }),
    messageEvent("Done."),
  ].join("");

  assert.equal(countProgressSteps(tail), 2);
});

test("prefers ACP tool title over name when present", () => {
  const model = buildProgressViewModel(titledToolEvent("tool_1", "Read .agent/src/run.ts"), {
    runId: "title",
  });

  assert.equal(model.recentActivity[0]?.label, "📖 Read");
  assert.equal(model.recentActivity[0]?.detail, "Read .agent/src/run.ts");
  assert.match(renderRunning(model), /- 📖 Read `Read \.agent\/src\/run\.ts` \(completed\)/);
});

test("classifies tools by stable name while rendering title details", () => {
  const model = buildProgressViewModel(titledToolEvent("shell", "npm test"), {
    runId: "stable-name",
  });

  assert.equal(model.recentActivity[0]?.label, "💻 Ran");
  assert.equal(model.recentActivity[0]?.detail, "npm test");
  assert.match(renderRunning(model), /- 💻 Ran `npm test` \(completed\)/);
});

test("collapses related tool call updates while preserving title metadata", () => {
  const tail = [
    correlatedToolEvent("tool_call", "call-1", {
      name: "tool_1",
      title: "Read .agent/src/progress-render.ts",
      status: "running",
    }),
    correlatedToolEvent("tool_call_update", "call-1", {
      status: "completed",
    }),
  ].join("");
  const model = buildProgressViewModel(tail, {
    runId: "tool-updates",
    route: "implement",
    elapsedMs: 2_000,
  });

  assert.equal(model.stepCount, 1);
  assert.deepEqual(model.recentActivity, [
    {
      kind: "tool",
      label: "📖 Read",
      detail: "Read .agent/src/progress-render.ts",
      status: "completed",
    },
  ]);

  const body = renderRunning(model);
  assert.match(body, /Sepo is working — implement · 2s · 1 step/);
  assert.match(body, /- 📖 Read `Read \.agent\/src\/progress-render\.ts` \(completed\)/);
  assert.doesNotMatch(body, /Used tool/);
});

test("preserves richer titles when updates repeat generic names", () => {
  const tail = [
    correlatedToolEvent("tool_call", "call-2", {
      name: "tool_1",
      title: "Read .agent/package.json",
      status: "running",
    }),
    correlatedToolEvent("tool_call_update", "call-2", {
      name: "tool_1",
      status: "completed",
    }),
  ].join("");
  const model = buildProgressViewModel(tail, {
    runId: "generic-update",
  });

  assert.equal(model.stepCount, 1);
  assert.deepEqual(model.recentActivity, [
    {
      kind: "tool",
      label: "📖 Read",
      detail: "Read .agent/package.json",
      status: "completed",
    },
  ]);
});

test("collapses no-toolCallId shell call and update events", () => {
  const model = buildProgressViewModel(`${toolEvent("shell", "running")}${toolUpdateEvent("shell")}`, {
    runId: "shell-no-id",
  });

  assert.equal(model.stepCount, 1);
  assert.deepEqual(model.recentActivity, [
    {
      kind: "tool",
      label: "💻 Ran",
      detail: "shell",
      status: "completed",
    },
  ]);
  assert.match(renderRunning(model), /- 💻 Ran `shell` \(completed\)/);
});

test("truncates long messages deterministically", () => {
  const model = buildProgressViewModel(messageEvent("x".repeat(40)), {
    runId: "truncate",
    elapsedMs: 1_000,
    maxMessageChars: 20,
  });

  assert.equal(model.lastMessage, `${"x".repeat(19)}…`);
  assert.equal(renderRunning(model), renderRunning(model));
});

test("renderFinal collapses activity and includes outcome and marker", () => {
  const model = buildProgressViewModel(`${toolEvent("Write")}${messageEvent("Done.")}`, {
    runId: "run final",
    route: "implement",
    elapsedMs: 291_000,
  });

  const success = renderFinal(model, "success");
  assert.match(success, /### ✅ Sepo finished — implement · 4m51s · 2 steps/);
  assert.match(success, /<details>\n<summary>Activity<\/summary>/);
  assert.match(success, /- ✏️ Edited `Write` \(completed\)/);
  assert.match(success, /<!-- sepo-progress:run-run-final -->/);

  const failure = renderFinal(model, "failure");
  assert.match(failure, /### ❌ Sepo finished with errors/);

  const finished = renderFinal(model, "finished");
  assert.match(finished, /### Sepo finished — implement · 4m51s · 2 steps/);
  assert.doesNotMatch(finished, /✅|❌/);
});

test("renderCancelled attributes the cancelling login", () => {
  const model = buildProgressViewModel(toolEvent("Glob"), {
    runId: "cancelled",
    route: "implement",
    elapsedMs: 5_000,
  });

  const body = renderCancelled(model, "@octocat");
  assert.match(body, /### ⏹️ Sepo cancelled — implement · 5s · 1 step/);
  assert.match(body, /Cancelled by @octocat\./);
  assert.match(body, /<!-- sepo-progress:run-cancelled -->/);
});

test("maps unknown tools to a generic label", () => {
  const model = buildProgressViewModel(toolEvent("custom_tool"), {
    runId: "unknown",
  });

  assert.equal(model.recentActivity[0]?.label, "🔧 Used tool");
  assert.match(renderRunning(model), /- 🔧 Used tool `custom_tool` \(completed\)/);
});

test("progressMarker sanitizes empty and unsafe run ids", () => {
  assert.equal(progressMarker(""), "<!-- sepo-progress:run-unknown -->");
  assert.equal(progressMarker("run 12/<x>"), "<!-- sepo-progress:run-run-12--x- -->");
});
