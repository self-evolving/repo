"use strict";

// Executes the Claude CLI cache-key script extracted from
// setup-agent-runtime against stubbed platform tools, proving the
// installer-faithful platform resolution and channel bucketing behave —
// including the Alpine case where ldd prints musl but exits nonzero under
// this shell's pipefail default.

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

function runKeys({ unameS, unameM, lddExit = 1, lddOut = "", translated = "0", version = "", installClaude = "true" }) {
  const tempDir = mkdtempSync(join(tmpdir(), "cli-keys-"));
  const outputPath = join(tempDir, "output.txt");
  const envPath = join(tempDir, "env.txt");
  const scriptPath = join(tempDir, "keys.sh");
  writeFileSync(scriptPath, extractKeysScript());
  writeFileSync(outputPath, "");
  writeFileSync(envPath, "");

  stub(tempDir, "uname", [
    'case "$1" in',
    `  -s) echo "${unameS}" ;;`,
    `  -m) echo "${unameM}" ;;`,
    `  *) echo "${unameS}" ;;`,
    "esac",
  ]);
  stub(tempDir, "ldd", [`printf '%s\\n' "${lddOut}"`, `exit ${lddExit}`]);
  stub(tempDir, "sysctl", [`echo "${translated}"`]);
  stub(tempDir, "date", ['echo "2026-29"']);
  stub(tempDir, "tr", ['exec /usr/bin/tr "$@"']);
  stub(tempDir, "grep", ['exec /usr/bin/grep "$@"']);
  stub(tempDir, "ls", [
    // The musl loader-file probe must miss in fixtures; delegate real ls
    // for anything else so the glob check exits nonzero.
    'if [[ "$*" == *libc.musl* ]]; then exit 2; fi',
    'exec /bin/ls "$@"',
  ]);

  const result = spawnSync("bash", ["-e", "-o", "pipefail", scriptPath], {
    encoding: "utf8",
    env: {
      INSTALL_CLAUDE: installClaude,
      CLAUDE_VERSION: version,
      GITHUB_OUTPUT: outputPath,
      GITHUB_ENV: envPath,
      HOME: tempDir,
      PATH: `${tempDir}:/usr/bin:/bin`,
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

test("cli cache key resolves installer-faithful platforms", () => {
  const glibc = runKeys({ unameS: "Linux", unameM: "x86_64", lddOut: "ldd (GNU libc) 2.39", lddExit: 0 });
  assert.equal(glibc.result.status, 0, glibc.result.stderr);
  assert.match(glibc.outputs.claude_key, /^sepo-cli-claude-linux-x86_64-latest-2026-29-/);

  // Alpine: ldd prints musl but exits nonzero — pipefail must not swallow it.
  const musl = runKeys({ unameS: "Linux", unameM: "x86_64", lddOut: "musl libc (x86_64)", lddExit: 1 });
  assert.equal(musl.result.status, 0, musl.result.stderr);
  assert.match(musl.outputs.claude_key, /^sepo-cli-claude-linux-x86_64-musl-latest-2026-29-/);

  const rosetta = runKeys({ unameS: "Darwin", unameM: "x86_64", translated: "1" });
  assert.equal(rosetta.result.status, 0, rosetta.result.stderr);
  assert.match(rosetta.outputs.claude_key, /^sepo-cli-claude-darwin-x86_64-rosetta-latest-2026-29-/);
});

test("cli cache key buckets mutable channels and pins exact versions", () => {
  const stable = runKeys({ unameS: "Linux", unameM: "aarch64", version: "stable" });
  assert.match(stable.outputs.claude_key, /-stable-2026-29-/);

  const pinned = runKeys({ unameS: "Linux", unameM: "aarch64", version: "1.2.3" });
  assert.match(pinned.outputs.claude_key, /-1\.2\.3-/);
  assert.doesNotMatch(pinned.outputs.claude_key, /2026-29/);
});

test("action-managed installs disable the auto-updater; preinstalled do not", () => {
  const managed = runKeys({ unameS: "Linux", unameM: "x86_64" });
  assert.equal(managed.outputs.need_claude, "true");
  assert.match(managed.persistedEnv, /DISABLE_AUTOUPDATER=1/);

  const skipped = runKeys({ unameS: "Linux", unameM: "x86_64", installClaude: "false" });
  assert.equal(skipped.outputs.need_claude, "false");
  assert.doesNotMatch(skipped.persistedEnv, /DISABLE_AUTOUPDATER/);
});
