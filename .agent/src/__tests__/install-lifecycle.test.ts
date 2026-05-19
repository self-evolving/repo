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
      "configure-target-git-auth",
      "resolve-source-release",
      "checkout-source-release",
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
  assert.equal(plan.steps[0]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.match(plan.steps[1]?.command || "", /gh pr list --repo foo\/bar --head agent\/install-agent-infra/);
  assert.match(plan.steps[2]?.command || "", /gh auth setup-git/);
  assert.equal(plan.steps[2]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.match(plan.steps[4]?.commandTemplate || "", /git clone --depth 1 --branch {{source_ref}}/);
  assert.equal(plan.steps[6]?.command, undefined);
  assert.match(plan.steps[5]?.commandTemplate || "", /gh repo clone foo\/bar {{target_worktree}}/);
  assert.equal(plan.steps[5]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.match(plan.steps[6]?.commandTemplate || "", /{{target_worktree}}/);
  assert.match(plan.steps[6]?.commandTemplate || "", /{{target_default_branch}}/);
  assert.equal(plan.steps[6]?.templateSlots?.[0]?.sourceStep, "setup-target-worktree");
  assert.match(plan.steps[7]?.commandTemplate || "", /rsync -a/);
  assert.equal(plan.steps[7]?.templateSlots?.[0]?.sourceStep, "checkout-source-release");
  assert.match(plan.steps[9]?.commandTemplate || "", /git -C {{target_worktree}} add/);
  assert.match(plan.steps[10]?.commandTemplate || "", /git -C {{target_worktree}} commit/);
  assert.match(plan.steps[11]?.commandTemplate || "", /git -C {{target_worktree}} push/);
  assert.equal(plan.steps[11]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.match(plan.steps[12]?.commandTemplate || "", /{{install_pr_body_file}}/);
  assert.equal(plan.steps[12]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.equal(plan.steps[12]?.templateSlots?.[1]?.sourceStep, "commit-install-changes");
  assert.doesNotMatch(JSON.stringify(plan), /GITHUB_TOKEN|AGENT_PAT|github\.token|steps\.auth\.outputs\.token/);
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
