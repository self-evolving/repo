import test from "node:test";
import assert from "node:assert/strict";

import { buildInstallLifecyclePlan, DEFAULT_INSTALL_BRANCH } from "../install-lifecycle.js";

test("buildInstallLifecyclePlan emits deterministic install route steps", () => {
  const plan = buildInstallLifecyclePlan({
    requestText: "@sepo-agent /install can you install Sepo into https://github.com/foo/bar?",
  });

  assert.equal(plan.status, "clear");
  assert.equal(plan.targetRepo, "foo/bar");
  assert.equal(plan.installBranch, DEFAULT_INSTALL_BRANCH);
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    [
      "prepare-install-worktree",
      "resolve-source-release",
      "copy-install-scope",
      "validate-install-diff",
      "publish-install-pr",
    ],
  );
  assert.match(plan.steps[0]?.command || "", /install-fork-pr\.js prepare --target-repo foo\/bar/);
  assert.match(plan.steps[0]?.description || "", /current target default branch/);
  assert.equal(plan.steps[2]?.templateSlots?.[1]?.sourceStep, "prepare-install-worktree");
  assert.match(plan.steps[4]?.commandTemplate || "", /install-fork-pr\.js publish --target-repo foo\/bar/);
  assert.match(plan.steps[4]?.commandTemplate || "", /{{target_default_branch}}/);
  assert.match(plan.steps[4]?.commandTemplate || "", /{{fork_repo}}/);
  assert.match(plan.steps[4]?.commandTemplate || "", /{{install_pr_body_file}}/);
  assert.equal(plan.steps[4]?.templateSlots?.[0]?.sourceStep, "prepare-install-worktree");
  assert.doesNotMatch(JSON.stringify(plan), /<target-default-branch>|<install-pr-body\.md>/);
});

test("buildInstallLifecyclePlan blocks missing and ambiguous install targets", () => {
  const missing = buildInstallLifecyclePlan({ requestText: "@sepo-agent /install please" });
  assert.equal(missing.status, "missing");
  assert.deepEqual(missing.steps, []);

  const ambiguous = buildInstallLifecyclePlan({ requestText: "Install into foo/bar or baz/qux" });
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidates, ["foo/bar", "baz/qux"]);
  assert.deepEqual(ambiguous.steps, []);
});
