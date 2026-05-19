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
      "prepare-target-branch",
      "copy-install-scope",
      "validate-install-diff",
      "open-install-pr",
    ],
  );
  assert.match(plan.steps[0]?.command || "", /gh api repos\/foo\/bar/);
  assert.match(plan.steps[1]?.command || "", /gh pr list --repo foo\/bar --head agent\/install-agent-infra/);
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
