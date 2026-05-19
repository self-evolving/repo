import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInstallLifecyclePlan, DEFAULT_INSTALL_BRANCH } from "../install-lifecycle.js";

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
      "merge-generated-output-gitignore",
      "validate-install-diff",
      "stage-install-changes",
      "commit-install-changes",
      "write-install-pr-body",
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
  assert.match(plan.steps[6]?.commandTemplate || "", /\.agent\/dist\/|\.agent\/node_modules\/|grep -Fxq/);
  assert.equal(plan.steps[6]?.templateSlots?.[0]?.sourceStep, "prepare-install-worktree");
  assert.match(plan.steps[8]?.commandTemplate || "", /git -C {{target_worktree}} add .agent .github .gitignore/);
  assert.match(plan.steps[9]?.commandTemplate || "", /git -C {{target_worktree}} commit/);
  assert.match(plan.steps[10]?.commandTemplate || "", /\.sepo-install-pr-body\.md/);
  assert.match(plan.steps[10]?.commandTemplate || "", /Required setup after merge/);
  assert.match(plan.steps[10]?.commandTemplate || "", /{{validation_summary}}/);
  assert.equal(plan.steps[10]?.templateSlots?.at(-1)?.sourceStep, "prepare-install-worktree");
  assert.match(plan.steps[11]?.commandTemplate || "", /install-fork-pr\.js publish --target-repo foo\/bar/);
  assert.match(plan.steps[11]?.commandTemplate || "", /{{target_default_branch}}/);
  assert.match(plan.steps[11]?.commandTemplate || "", /{{fork_repo}}/);
  assert.match(plan.steps[11]?.commandTemplate || "", /{{install_pr_body_file}}/);
  assert.equal(plan.steps[11]?.env?.GH_TOKEN, "AGENT_INSTALL_PAT");
  assert.equal(plan.steps[11]?.templateSlots?.[3]?.sourceStep, "write-install-pr-body");
  assert.doesNotMatch(JSON.stringify(plan), /GITHUB_TOKEN|github\.token|steps\.auth\.outputs\.token/);
  assert.doesNotMatch(JSON.stringify(plan), /"GH_TOKEN":"AGENT_PAT"/);
  assert.doesNotMatch(JSON.stringify(plan), /<target-default-branch>|<install-pr-body\.md>/);
});

test("generated output gitignore step appends missing entries idempotently", () => {
  const plan = buildInstallLifecyclePlan({
    requestText: "@sepo-agent /install can you install Sepo into https://github.com/foo/bar?",
  });
  const step = plan.steps.find((candidate) => candidate.id === "merge-generated-output-gitignore");
  assert.ok(step?.commandTemplate);

  const workdir = mkdtempSync(join(tmpdir(), "sepo-install-gitignore-"));
  try {
    const gitignore = join(workdir, ".gitignore");
    writeFileSync(gitignore, "target-owned-entry\n.agent/dist/\n");
    const command = step.commandTemplate.replaceAll("{{target_worktree}}", shellArg(workdir));

    execFileSync("bash", ["-lc", command]);
    const merged = readFileSync(gitignore, "utf8");
    assert.equal(merged, "target-owned-entry\n.agent/dist/\n.agent/node_modules/\n");

    execFileSync("bash", ["-lc", command]);
    assert.equal(readFileSync(gitignore, "utf8"), merged);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("generated output gitignore step creates missing gitignore", () => {
  const plan = buildInstallLifecyclePlan({
    requestText: "@sepo-agent /install can you install Sepo into https://github.com/foo/bar?",
  });
  const step = plan.steps.find((candidate) => candidate.id === "merge-generated-output-gitignore");
  assert.ok(step?.commandTemplate);

  const workdir = mkdtempSync(join(tmpdir(), "sepo-install-gitignore-"));
  try {
    const gitignore = join(workdir, ".gitignore");
    const command = step.commandTemplate.replaceAll("{{target_worktree}}", shellArg(workdir));

    execFileSync("bash", ["-lc", command]);
    assert.equal(readFileSync(gitignore, "utf8"), ".agent/dist/\n.agent/node_modules/\n");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
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
