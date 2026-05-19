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
      "check-target-write",
      "check-existing-install-pr",
      "resolve-source-release",
      "setup-target-worktree",
      "prepare-target-branch",
      "copy-install-scope",
      "validate-install-diff",
      "stage-install-changes",
      "commit-install-changes",
      "push-install-branch",
      "open-install-pr",
    ],
  );
  assert.match(plan.steps[0]?.command || "", /gh api repos\/foo\/bar/);
  assert.match(plan.steps[1]?.command || "", /gh pr list --repo foo\/bar --head agent\/install-agent-infra/);
  assert.match(plan.steps[3]?.commandTemplate || "", /git clone https:\/\/github\.com\/foo\/bar\.git/);
  assert.equal(plan.steps[4]?.command, undefined);
  assert.match(plan.steps[4]?.commandTemplate || "", /{{target_worktree}}/);
  assert.match(plan.steps[4]?.commandTemplate || "", /{{target_default_branch}}/);
  assert.equal(plan.steps[4]?.templateSlots?.[0]?.sourceStep, "setup-target-worktree");
  assert.match(plan.steps[7]?.commandTemplate || "", /git -C {{target_worktree}} add/);
  assert.match(plan.steps[8]?.commandTemplate || "", /git -C {{target_worktree}} commit/);
  assert.match(plan.steps[9]?.commandTemplate || "", /git -C {{target_worktree}} push/);
  assert.match(plan.steps[10]?.commandTemplate || "", /{{install_pr_body_file}}/);
  assert.equal(plan.steps[10]?.templateSlots?.[1]?.sourceStep, "commit-install-changes");
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
