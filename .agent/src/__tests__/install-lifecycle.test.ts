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
      "prepare-source-checkout-dir",
      "checkout-source-release",
      "audit-github-copy-conflicts",
      "copy-install-scope",
      "validate-install-diff",
      "stage-install-changes",
      "commit-install-changes",
      "publish-install-pr",
    ],
  );
  assert.match(plan.steps[0]?.command || "", /install-fork-pr\.js prepare --target-repo foo\/bar/);
  assert.equal(plan.steps[0]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.match(plan.steps[0]?.description || "", /current target default branch/);
  assert.equal(plan.steps[2]?.command, "mktemp -d");
  assert.match(plan.steps[3]?.commandTemplate || "", /git clone --depth 1 --branch {{source_ref}}/);
  assert.equal(plan.steps[3]?.templateSlots?.[1]?.sourceStep, "prepare-source-checkout-dir");
  assert.match(plan.steps[4]?.commandTemplate || "", /audit|comm -12|target \.github files already exist/);
  assert.match(plan.steps[5]?.commandTemplate || "", /rsync -a/);
  assert.match(plan.steps[5]?.commandTemplate || "", /--ignore-existing/);
  assert.equal(plan.steps[5]?.templateSlots?.[0]?.sourceStep, "checkout-source-release");
  assert.equal(plan.steps[5]?.templateSlots?.[1]?.sourceStep, "prepare-install-worktree");
  assert.match(plan.steps[7]?.commandTemplate || "", /git -C {{target_worktree}} add/);
  assert.match(plan.steps[8]?.commandTemplate || "", /git -C {{target_worktree}} commit/);
  assert.match(plan.steps[9]?.commandTemplate || "", /install-fork-pr\.js publish --target-repo foo\/bar/);
  assert.match(plan.steps[9]?.commandTemplate || "", /{{target_default_branch}}/);
  assert.match(plan.steps[9]?.commandTemplate || "", /{{fork_repo}}/);
  assert.match(plan.steps[9]?.commandTemplate || "", /{{install_pr_body_file}}/);
  assert.equal(plan.steps[9]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.equal(plan.steps[9]?.templateSlots?.[3]?.sourceStep, "commit-install-changes");
  assert.doesNotMatch(JSON.stringify(plan), /GITHUB_TOKEN|github\.token|steps\.auth\.outputs\.token/);
  assert.doesNotMatch(JSON.stringify(plan), /"GH_TOKEN":"AGENT_PAT"/);
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
