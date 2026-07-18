"use strict";

// Executes the Claude CLI cache-key script extracted from
// setup-agent-runtime, proving channel bucketing (mutable channels rotate
// weekly, pins key exactly) and the need-gated auto-updater opt-out.

const { strict: assert } = require("node:assert");
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { parse: parseYaml } = require("yaml");

const ACTION_PATH = resolve(__dirname, "../../../.github/actions/setup-agent-runtime/action.yml");

function extractKeysScript() {
  const action = parseYaml(readFileSync(ACTION_PATH, "utf8"));
  const steps = action.runs.steps;
  const step = steps.find((candidate) => candidate && candidate.id === "cli");
  assert.ok(step && typeof step.run === "string", "cli keys step should exist");
  // GitHub resolves ${{ ... }} expressions before execution; replace them
  // with a stable placeholder so the raw script runs under plain bash.
  return step.run.replace(/\$\{\{[^}]*\}\}/g, "EXPR");
}

function stub(dir, name, lines) {
  const path = join(dir, name);
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines].join("\n") + "\n");
  chmodSync(path, 0o755);
}

function runKeys({ version = "", installClaude = "true", extraEnv = {} } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "cli-keys-"));
  const outputPath = join(tempDir, "output.txt");
  const envPath = join(tempDir, "env.txt");
  const scriptPath = join(tempDir, "keys.sh");
  writeFileSync(scriptPath, extractKeysScript());
  writeFileSync(outputPath, "");
  writeFileSync(envPath, "");

  stub(tempDir, "date", ['echo "2026-29"']);

  const result = spawnSync("bash", ["-e", "-o", "pipefail", scriptPath], {
    encoding: "utf8",
    env: {
      INSTALL_CLAUDE: installClaude,
      CLAUDE_VERSION: version,
      GITHUB_OUTPUT: outputPath,
      GITHUB_ENV: envPath,
      HOME: tempDir,
      PATH: `${tempDir}:/usr/bin:/bin`,
      ...extraEnv,
    },
  });

  const outputs = Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const persistedEnv = readFileSync(envPath, "utf8");
  rmSync(tempDir, { recursive: true, force: true });
  return { outputs, persistedEnv, result };
}

test("cli cache key buckets mutable channels and pins exact versions", () => {
  const unpinned = runKeys();
  assert.match(unpinned.outputs.claude_key, /-latest-2026-29-/);

  const stable = runKeys({ version: "stable" });
  assert.match(stable.outputs.claude_key, /-stable-2026-29-/);

  const pinned = runKeys({ version: "1.2.3" });
  assert.match(pinned.outputs.claude_key, /-1\.2\.3-/);
  assert.doesNotMatch(pinned.outputs.claude_key, /2026-29/);
});

test("action-managed installs disable the auto-updater; preinstalled do not", () => {
  const managed = runKeys();
  assert.equal(managed.outputs.need_claude, "true");
  assert.match(managed.persistedEnv, /DISABLE_AUTOUPDATER=1/);

  const skipped = runKeys({ installClaude: "false" });
  assert.equal(skipped.outputs.need_claude, "false");
  assert.doesNotMatch(skipped.persistedEnv, /DISABLE_AUTOUPDATER/);

  // A pre-set operator policy is preserved untouched.
  const preset = runKeys({ extraEnv: { DISABLE_AUTOUPDATER: "0" } });
  assert.equal(preset.outputs.need_claude, "true");
  assert.doesNotMatch(preset.persistedEnv, /DISABLE_AUTOUPDATER/);
});
