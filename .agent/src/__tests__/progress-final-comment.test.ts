import { test } from "node:test";
import { strict as assert } from "node:assert";

import { mergeFinalBodyWithProgress } from "../progress-final-comment.js";
import { renderRunning } from "../progress-render.js";

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

test("mergeFinalBodyWithProgress preserves activity by default without duplicating it", () => {
  const runningBody = renderRunning({
    status: "running",
    runId: "abc",
    route: "fix-pr",
    elapsedMs: 31_000,
    stepCount: 1,
    recentActivity: [{ kind: "message", label: "Message", detail: "Checking." }],
    lastMessage: "Checking.",
  });

  const merged = mergeFinalBodyWithProgress("Answer body.", runningBody);

  assert.match(merged, /^Answer body\./);
  assert.match(merged, /<summary>Sepo activity<\/summary>/);
  assert.match(merged, /<!-- sepo-progress:run-abc -->/);
  assert.equal(countOccurrences(merged, "Recent activity"), 1);
  assert.equal(countOccurrences(merged, '- Message "Checking."'), 1);
  assert.equal(countOccurrences(merged, "Last message"), 1);
});

test("mergeFinalBodyWithProgress can omit activity while preserving the progress marker", () => {
  const runningBody = renderRunning({
    status: "running",
    runId: "abc",
    route: "answer",
    elapsedMs: 31_000,
    stepCount: 1,
    recentActivity: [{ kind: "message", label: "Message", detail: "Checking." }],
    lastMessage: "Checking.",
  });

  const merged = mergeFinalBodyWithProgress("Answer body.", runningBody, false);

  assert.equal(merged, "Answer body.\n\n<!-- sepo-progress:run-abc -->");
});
