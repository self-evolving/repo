import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureRubricsStructure,
  formatRubricsForPrompt,
  loadRubrics,
  selectRubrics,
  tokenizeRubricQuery,
} from "../rubrics.js";
import { runRubricsSelectCli } from "../cli/rubrics/select.js";
import {
  getRubricsModeForRoute,
  isRubricsHardDisabledRoute,
  parseRubricsPolicy,
  RUBRICS_HARD_DISABLED_ROUTES,
  rubricsModeAllowsRead,
  rubricsModeAllowsWrite,
} from "../rubrics-policy.js";
import { resolveRubricsMode } from "../cli/rubrics/resolve-policy.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rubrics-test-"));
}

function writeRubric(root: string, name: string, body: string): void {
  const dir = join(root, "rubrics", "coding");
  ensureRubricsStructure(root, "self-evolving/repo");
  writeFileSync(join(dir, name), body, "utf8");
}

function withoutGithubOutput<T>(fn: () => T): T {
  const previous = process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_OUTPUT;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = previous;
    }
  }
}

test("ensureRubricsStructure seeds the user/team rubric branch layout", () => {
  const root = tempDir();
  const result = ensureRubricsStructure(root, "self-evolving/repo");
  assert.ok(result.createdFiles.some((file) => file.endsWith("README.md")));
  assert.ok(result.createdFiles.some((file) => file.endsWith("rubrics/coding/.gitkeep")));
});

test("loadRubrics validates and normalizes rubric YAML", () => {
  const root = tempDir();
  writeRubric(root, "add-regression-tests.yaml", `
schema_version: 1
id: add-regression-tests
title: Add regression tests
description: >-
  Bug fixes should include regression tests.
type: generic
domain: coding_workflow
applies_to:
  - implement
severity: must
weight: 5
status: active
examples:
  - source: https://example.test/pr/1
    note: Reviewer requested a regression test.
`);

  const { rubrics, errors } = loadRubrics(root);
  assert.deepEqual(errors, []);
  assert.equal(rubrics.length, 1);
  assert.equal(rubrics[0]?.id, "add-regression-tests");
  assert.equal(rubrics[0]?.severity, "must");
  assert.equal(rubrics[0]?.path, "rubrics/coding/add-regression-tests.yaml");
});

test("loadRubrics accepts legacy category coding as coding_workflow", () => {
  const root = tempDir();
  writeRubric(root, "legacy.yaml", `
id: legacy-category
title: Legacy category
description: Legacy category should still load.
category: coding
applies_to: [implement]
`);

  const { rubrics, errors } = loadRubrics(root);
  assert.deepEqual(errors, []);
  assert.equal(rubrics[0]?.domain, "coding_workflow");
});

test("loadRubrics rejects duplicate ids", () => {
  const root = tempDir();
  const body = `
id: duplicate-rubric
title: Duplicate
description: Same id.
applies_to: [implement]
`;
  writeRubric(root, "one.yaml", body);
  writeRubric(root, "two.yaml", body);

  const { rubrics, errors } = loadRubrics(root);
  assert.equal(rubrics.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message || "", /duplicate id/);
});

test("loadRubrics rejects unsupported schema versions and invalid weights", () => {
  const root = tempDir();
  writeRubric(root, "schema.yaml", `
schema_version: 2
id: future-rubric
title: Future schema
description: Future schema should not silently load.
applies_to: [implement]
`);
  writeRubric(root, "weight.yaml", `
id: bad-weight
title: Bad weight
description: Weight should be an integer from 1 to 10.
applies_to: [implement]
weight: 12
`);

  const { rubrics, errors } = loadRubrics(root);
  assert.equal(rubrics.length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => /schema_version must be 1/.test(error.message)));
  assert.ok(errors.some((error) => /weight must be an integer from 1 to 10/.test(error.message)));
});

test("selectRubrics filters by route and ranks by query matches", () => {
  const root = tempDir();
  writeRubric(root, "regression.yaml", `
id: add-regression-tests
title: Add regression tests
description: Include regression tests for bug fixes.
applies_to: [implement]
severity: must
weight: 5
`);
  writeRubric(root, "concise.yaml", `
id: concise-summary
title: Keep summaries concise
description: PR comments should be concise.
domain: communication
applies_to: [answer]
severity: should
weight: 2
`);

  const { selected, errors } = selectRubrics({
    rootDir: root,
    route: "implement",
    query: "fix bug regression test",
  });
  assert.deepEqual(errors, []);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.rubric.id, "add-regression-tests");
  assert.ok(selected[0]?.matchedTerms.includes("regression"));
});

test("selectRubrics applies implementation rubrics to fix-pr", () => {
  const root = tempDir();
  writeRubric(root, "implementation.yaml", `
id: implementation-guidance
title: Implementation guidance
description: PR fixes should reuse implementation guidance.
applies_to: [implement]
severity: should
`);

  const { selected, errors } = selectRubrics({
    rootDir: root,
    route: "fix-pr",
    query: "fix pull request",
  });
  assert.deepEqual(errors, []);
  assert.equal(selected[0]?.rubric.id, "implementation-guidance");
});

test("selectRubrics can include all routes for rubric review", () => {
  const root = tempDir();
  writeRubric(root, "implementation.yaml", `
id: implementation-guidance
title: Implementation guidance
description: Implementation guidance should be available to rubric review.
applies_to: [implement]
severity: should
`);
  writeRubric(root, "answer.yaml", `
id: answer-guidance
title: Answer guidance
description: Answer guidance should also be available to rubric review.
domain: communication
applies_to: [answer]
severity: should
`);

  const routeFiltered = selectRubrics({
    rootDir: root,
    route: "rubrics-review",
    query: "",
  });
  assert.equal(routeFiltered.selected.length, 0);

  const allRoutes = selectRubrics({
    rootDir: root,
    route: "rubrics-review",
    query: "",
    allRoutes: true,
    limit: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(
    allRoutes.selected.map((entry) => entry.rubric.id).sort(),
    ["answer-guidance", "implementation-guidance"],
  );
});

test("selectRubrics can filter by domain", () => {
  const root = tempDir();
  writeRubric(root, "answer-workflow.yaml", `
id: answer-workflow
title: Answer workflow
description: Workflow guidance can apply to answers.
domain: coding_workflow
applies_to: [answer]
severity: must
`);
  writeRubric(root, "answer-communication.yaml", `
id: answer-communication
title: Answer communication
description: Answer runs should prefer communication rubrics.
domain: communication
applies_to: [answer]
severity: should
`);

  const { selected, errors } = selectRubrics({
    rootDir: root,
    route: "answer",
    query: "",
    domains: ["communication"],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(selected.map((entry) => entry.rubric.id), ["answer-communication"]);
});

test("rubrics select CLI can render valid rubrics in best-effort mode", () => {
  const root = tempDir();
  writeRubric(root, "valid.yaml", `
id: valid-rubric
title: Valid rubric
description: Valid rubrics should still be selected.
applies_to: [implement]
`);
  writeRubric(root, "invalid.yaml", `
id: invalid-rubric
title: Invalid rubric
description: Invalid rubrics should warn without blocking best-effort reads.
applies_to: [implement]
weight: 99
`);
  const outputFile = join(root, "selected.md");

  const exitCode = withoutGithubOutput(() => runRubricsSelectCli([
    "--dir", root,
    "--route", "implement",
    "--query", "valid",
    "--best-effort",
    "--output-file", outputFile,
  ], { GITHUB_OUTPUT: "" }));

  assert.equal(exitCode, 0);
  assert.match(readFileSync(outputFile, "utf8"), /valid-rubric/);
});

test("rubrics select CLI filters answer rubrics by requested domains", () => {
  const root = tempDir();
  writeRubric(root, "workflow.yaml", `
id: workflow-answer
title: Workflow answer
description: Workflow answer guidance.
domain: coding_workflow
applies_to: [answer]
`);
  writeRubric(root, "communication.yaml", `
id: communication-answer
title: Communication answer
description: Communication answer guidance.
domain: communication
applies_to: [answer]
`);
  const outputFile = join(root, "selected-answer.md");

  const exitCode = withoutGithubOutput(() => runRubricsSelectCli([
    "--dir", root,
    "--route", "answer",
    "--domains", "communication",
    "--output-file", outputFile,
  ], { GITHUB_OUTPUT: "" }));

  const rendered = readFileSync(outputFile, "utf8");
  assert.equal(exitCode, 0);
  assert.match(rendered, /communication-answer/);
  assert.doesNotMatch(rendered, /workflow-answer/);
});

test("formatRubricsForPrompt renders selected rubrics as markdown", () => {
  const root = tempDir();
  writeRubric(root, "regression.yaml", `
id: add-regression-tests
title: Add regression tests
description: Include regression tests for bug fixes.
applies_to: [implement]
severity: must
weight: 5
`);
  const { selected } = selectRubrics({ rootDir: root, route: "implement", query: "regression" });
  const markdown = formatRubricsForPrompt(selected);
  assert.match(markdown, /### Add regression tests/);
  assert.match(markdown, /`add-regression-tests`/);
});

test("tokenizeRubricQuery drops short non-numeric tokens", () => {
  assert.deepEqual(tokenizeRubricQuery("a PR 51 regression"), ["51", "regression"]);
});

test("rubrics policy defaults to read-only and supports route overrides", () => {
  const empty = parseRubricsPolicy("");
  assert.equal(getRubricsModeForRoute(empty, "implement"), "read-only");
  assert.equal(rubricsModeAllowsRead("read-only"), true);
  assert.equal(rubricsModeAllowsWrite("read-only"), false);

  const policy = parseRubricsPolicy(JSON.stringify({
    default_mode: "disabled",
    route_overrides: { "rubrics-update": "enabled" },
  }));
  assert.equal(getRubricsModeForRoute(policy, "answer"), "disabled");
  assert.equal(getRubricsModeForRoute(policy, "rubrics-update"), "enabled");

  const dispatchPolicy = parseRubricsPolicy(JSON.stringify({
    default_mode: "enabled",
    route_overrides: { dispatch: "enabled" },
  }));
  assert.deepEqual(RUBRICS_HARD_DISABLED_ROUTES, ["dispatch"]);
  assert.equal(isRubricsHardDisabledRoute("DISPATCH"), true);
  assert.equal(getRubricsModeForRoute(dispatchPolicy, "dispatch"), "disabled");
});

test("rubrics mode hard-disables dispatch triage", () => {
  assert.equal(resolveRubricsMode({ ROUTE: "dispatch" }), "disabled");
  assert.equal(resolveRubricsMode({
    ROUTE: "dispatch",
    RUBRICS_MODE_OVERRIDE: "enabled",
    AGENT_RUBRICS_POLICY: JSON.stringify({ default_mode: "enabled" }),
  }), "disabled");
});
