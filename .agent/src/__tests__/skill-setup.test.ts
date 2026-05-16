import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
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
    assert.equal(skill.setupPath, "custom-skills/release-notes/setup.sh");
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

test("runSkillSetup skips missing setup scripts", () => {
  const repo = makeSkillRepo();
  try {
    const result = runSkillSetup({ repoRoot: repo, skillName: "demo" });
    assert.equal(result.setupRan, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runSkillSetup executes setup.sh with skill environment", () => {
  const repo = makeSkillRepo();
  try {
    writeFileSync(
      join(repo, ".skills", "demo", "setup.sh"),
      "printf '%s:%s:%s' \"$SKILL_NAME\" \"$SKILL_ROOT\" \"$SKILL_DIR\" > setup.out\n",
    );

    const result = runSkillSetup({ repoRoot: repo, skillName: "demo" });
    assert.equal(result.setupRan, true);
    const output = readFileSync(join(repo, "setup.out"), "utf8");
    assert.match(output, /^demo:/);
    assert.match(output, /\/\.skills:/);
    assert.match(output, /\/\.skills\/demo$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runSkillSetup refuses setup scripts from untrusted refs", () => {
  const repo = makeSkillRepo();
  try {
    writeFileSync(join(repo, ".skills", "demo", "setup.sh"), "true\n");
    assert.throws(
      () => runSkillSetup({ repoRoot: repo, skillName: "demo", trustedRef: false }),
      /Refusing to run .*untrusted PR checkout/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
