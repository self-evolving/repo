import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  formatProjectManagementSummary,
  planLabelChange,
  scoreProjectItem,
  type ProjectItem,
} from "../project-management.js";

const now = new Date("2026-04-29T12:00:00Z");

function item(overrides: Partial<ProjectItem>): ProjectItem {
  return {
    kind: "issue",
    number: 1,
    title: "Normal task",
    body: "",
    labels: [],
    createdAt: "2026-04-01T12:00:00Z",
    updatedAt: "2026-04-28T12:00:00Z",
    comments: 0,
    assignees: [],
    ...overrides,
  };
}

test("scores security regressions as high priority with high effort", () => {
  const score = scoreProjectItem(
    item({
      title: "Critical security regression",
      body: "This is urgent and blocks production.",
      labels: [{ name: "bug" }],
      comments: 6,
    }),
    now,
  );

  assert.equal(score.priority, "p0");
  assert.equal(score.effort, "high");
  assert.match(score.reasons.join(" "), /impact label/);
  assert.match(score.reasons.join(" "), /time-sensitive wording/);
});

test("scores stale reviewable PRs as low effort action items", () => {
  const score = scoreProjectItem(
    item({
      kind: "pull_request",
      number: 12,
      title: "Add small docs update",
      updatedAt: "2026-04-01T12:00:00Z",
      reviewDecision: "REVIEW_REQUIRED",
    }),
    now,
  );

  assert.equal(score.priority, "p3");
  assert.equal(score.effort, "low");
  assert.match(score.reasons.join(" "), /PR needs review action/);
  assert.match(score.reasons.join(" "), /stale open item/);
});

test("plans replacement of existing managed labels only", () => {
  const score = scoreProjectItem(
    item({
      title: "Critical security issue",
      comments: 5,
      labels: [
        { name: "priority/p3" },
        { name: "effort/low" },
        { name: "agent" },
      ],
    }),
    now,
  );

  assert.deepEqual(planLabelChange(score), {
    add: ["priority/p1", "effort/high"],
    remove: ["priority/p3", "effort/low"],
  });
});

test("formats a summary with run mode and label changes", () => {
  const score = scoreProjectItem(
    item({ title: "Critical security issue", comments: 5, labels: [{ name: "priority/p3" }] }),
    now,
  );
  const changes = new Map([["issue#1", planLabelChange(score)]]);

  const summary = formatProjectManagementSummary([score], changes, {
    dryRun: true,
    labelsApplied: false,
  });

  assert.match(summary, /Mode: dry run/);
  assert.match(summary, /Open items scored: 1/);
  assert.match(summary, /issue#1: Critical security issue/);
  assert.match(summary, /Top Triage Queue/);
  assert.match(summary, /\+priority\/p1, effort\/high/);
});
