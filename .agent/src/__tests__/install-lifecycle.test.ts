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
      "prepare-source-checkout-dir",
      "checkout-source-release",
      "setup-target-worktree",
      "prepare-target-branch",
      "audit-github-copy-conflicts",
      "copy-install-scope",
      "validate-install-diff",
      "stage-install-changes",
      "commit-install-changes",
      "push-install-branch",
      "open-install-pr",
    ],
  );
  assert.match(plan.steps[0]?.command || "", /gh api repos\/foo\/bar/);
  assert.match(plan.steps[0]?.command || "", /permissions\.push == true/);
  assert.match(plan.steps[0]?.command || "", /AGENT_INSTALL_PAT lacks push permission/);
  assert.equal(plan.steps[0]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.match(plan.steps[1]?.command || "", /gh pr list --repo foo\/bar --head agent\/install-agent-infra/);
  assert.match(plan.steps[2]?.command || "", /gh auth setup-git/);
  assert.equal(plan.steps[2]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.match(plan.steps[4]?.command || "", /mktemp -d/);
  assert.match(plan.steps[5]?.commandTemplate || "", /git clone --depth 1 --branch {{source_ref}}/);
  assert.equal(plan.steps[5]?.templateSlots?.[1]?.sourceStep, "prepare-source-checkout-dir");
  assert.equal(plan.steps[7]?.command, undefined);
  assert.match(plan.steps[6]?.commandTemplate || "", /gh repo clone foo\/bar {{target_worktree}}/);
  assert.equal(plan.steps[6]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.match(plan.steps[7]?.commandTemplate || "", /{{target_worktree}}/);
  assert.match(plan.steps[7]?.commandTemplate || "", /{{target_default_branch}}/);
  assert.equal(plan.steps[7]?.templateSlots?.[0]?.sourceStep, "setup-target-worktree");
  assert.match(plan.steps[8]?.commandTemplate || "", /comm -12/);
  assert.match(plan.steps[8]?.commandTemplate || "", /target \.github files already exist/);
  assert.equal(plan.steps[8]?.templateSlots?.[0]?.sourceStep, "prepare-source-checkout-dir");
  assert.match(plan.steps[9]?.commandTemplate || "", /rsync -a/);
  assert.match(plan.steps[9]?.commandTemplate || "", /--ignore-existing/);
  assert.equal(plan.steps[9]?.templateSlots?.[0]?.sourceStep, "prepare-source-checkout-dir");
  assert.match(plan.steps[11]?.commandTemplate || "", /git -C {{target_worktree}} add/);
  assert.match(plan.steps[12]?.commandTemplate || "", /git -C {{target_worktree}} commit/);
  assert.match(plan.steps[13]?.commandTemplate || "", /git -C {{target_worktree}} push/);
  assert.equal(plan.steps[13]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.match(plan.steps[14]?.commandTemplate || "", /{{install_pr_body_file}}/);
  assert.equal(plan.steps[14]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.equal(plan.steps[14]?.templateSlots?.[1]?.sourceStep, "commit-install-changes");
  assert.doesNotMatch(JSON.stringify(plan), /GITHUB_TOKEN|AGENT_PAT|github\.token|steps\.auth\.outputs\.token/);
  assert.doesNotMatch(JSON.stringify(plan), /<target-default-branch>|<install-pr-body\.md>/);
});

test("buildInstallLifecyclePlan blocks same-path GitHub asset overwrites", () => {
  const plan = buildInstallLifecyclePlan({
    requestText: "@sepo-agent /install https://github.com/foo/bar",
  });
  const auditStep = plan.steps.find((step) => step.id === "audit-github-copy-conflicts");
  const copyStep = plan.steps.find((step) => step.id === "copy-install-scope");
  assert.ok(auditStep);
  assert.ok(copyStep);
  assert.ok(plan.steps.indexOf(auditStep) < plan.steps.indexOf(copyStep));
  assert.match(auditStep.commandTemplate || "", /exit 1/);
  assert.match(copyStep.commandTemplate || "", /--ignore-existing/);
  assert.doesNotMatch(copyStep.commandTemplate || "", /\.github\/.*--delete/);
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
