import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  parseSkillSetupManifest,
  resolveSkillPackage,
  runSkillSetup,
} from "../skills.js";

function makeSkillRepo(skillRoot = ".skills", skillName = "demo"): string {
  const repo = mkdtempSync(join(tmpdir(), "sepo-skill-"));
  const skillDir = join(repo, skillRoot, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Demo\n");
  return repo;
}

test("resolveSkillPackage uses custom roots and repo-relative paths", () => {
  const repo = makeSkillRepo("custom-skills", "release-notes");
  try {
    const skill = resolveSkillPackage({
      repoRoot: repo,
      skillRoot: "custom-skills",
      skillName: "release-notes",
    });
    assert.equal(skill.skillExists, true);
    assert.equal(skill.setupExists, false);
    assert.equal(skill.skillPath, "custom-skills/release-notes/SKILL.md");
    assert.equal(skill.setupPath, "custom-skills/release-notes/skill-setup.yaml");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveSkillPackage rejects path traversal inputs", () => {
  const repo = makeSkillRepo();
  try {
    assert.throws(
      () => resolveSkillPackage({ repoRoot: repo, skillRoot: "../outside", skillName: "demo" }),
      /Skill root must stay inside the repository/,
    );
    assert.throws(
      () => resolveSkillPackage({ repoRoot: repo, skillName: "../../demo" }),
      /Invalid skill name/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("parseSkillSetupManifest validates the v1 schema", () => {
  const manifest = parseSkillSetupManifest(`
version: 1
env:
  TOOL_HOME: .cache/tool
steps:
  - name: Install helper
    run: npm install -g example
    timeout_minutes: 2
`);

  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.env, { TOOL_HOME: ".cache/tool" });
  assert.equal(manifest.steps[0].shell, "bash");
  assert.equal(manifest.steps[0].timeoutMinutes, 2);
  assert.throws(
    () => parseSkillSetupManifest("version: 2\nsteps: []\n"),
    /version must be 1/,
  );
  assert.throws(
    () => parseSkillSetupManifest("version: 1\nsteps:\n  - name: Missing run\n"),
    /steps\[0\]\.run/,
  );
});

test("runSkillSetup skips missing setup manifests", () => {
  const repo = makeSkillRepo();
  try {
    const result = runSkillSetup({ repoRoot: repo, skillName: "demo" });
    assert.equal(result.setupRan, false);
    assert.equal(result.stepCount, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runSkillSetup executes setup steps with manifest and step env", () => {
  const repo = makeSkillRepo();
  try {
    writeFileSync(
      join(repo, ".skills", "demo", "skill-setup.yaml"),
      `
version: 1
env:
  FROM_MANIFEST: manifest
steps:
  - name: Write marker
    run: printf '%s:%s:%s' "$SKILL_NAME" "$FROM_MANIFEST" "$FROM_STEP" > setup.out
    env:
      FROM_STEP: step
    timeout_minutes: 1
`,
    );

    const result = runSkillSetup({ repoRoot: repo, skillName: "demo" });
    assert.equal(result.setupRan, true);
    assert.equal(result.stepCount, 1);
    assert.equal(readFileSync(join(repo, "setup.out"), "utf8"), "demo:manifest:step");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runSkillSetup refuses setup manifests from untrusted refs", () => {
  const repo = makeSkillRepo();
  try {
    writeFileSync(
      join(repo, ".skills", "demo", "skill-setup.yaml"),
      "version: 1\nsteps:\n  - name: No-op\n    run: true\n",
    );
    assert.throws(
      () => runSkillSetup({ repoRoot: repo, skillName: "demo", trustedRef: false }),
      /Refusing to run .*pull_request checkout/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
