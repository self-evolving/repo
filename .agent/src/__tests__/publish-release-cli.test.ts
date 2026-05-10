import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function parseGithubOutput(path: string): Map<string, string> {
  const raw = readFileSync(path, "utf8");
  const outputs = new Map<string, string>();
  const blocks = raw.matchAll(/^([^<\n]+)<<([^\n]+)\n([\s\S]*?)\n\2$/gm);
  for (const [, name, , value] of blocks) {
    outputs.set(name, value);
  }
  return outputs;
}

test("publish-release creates a release for the package version when version is omitted", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-publish-release-"));
  try {
    const outputPath = join(tempDir, "github-output.txt");
    const callsPath = join(tempDir, "gh-calls.txt");
    const statePath = join(tempDir, "release-created");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(callsPath, "", "utf8");
    writeFileSync(
      join(tempDir, "gh"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ -f "$STATE_FILE" ]; then
    printf '{"url":"https://github.com/self-evolving/repo/releases/tag/v0.1.0"}\\n'
    exit 0
  fi
  exit 1
fi
if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  touch "$STATE_FILE"
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/publish-release.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        RUNNER_TEMP: tempDir,
        STATE_FILE: statePath,
        VERSION: "",
      },
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("version"), "0.1.0");
    assert.equal(outputs.get("tag"), "v0.1.0");
    assert.equal(outputs.get("release_action"), "created");

    const calls = readFileSync(callsPath, "utf8");
    assert.match(calls, /release create v0\.1\.0/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publish-release updates existing releases with explicit false flags", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-publish-release-"));
  try {
    const outputPath = join(tempDir, "github-output.txt");
    const callsPath = join(tempDir, "gh-calls.txt");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(callsPath, "", "utf8");
    writeFileSync(
      join(tempDir, "gh"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  printf '{"url":"https://github.com/self-evolving/repo/releases/tag/v0.1.0"}\\n'
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "edit" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/publish-release.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        PRERELEASE: "false",
        RUNNER_TEMP: tempDir,
        UPDATE_EXISTING: "true",
        VERSION: "",
        DRAFT: "false",
      },
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("release_action"), "updated");

    const calls = readFileSync(callsPath, "utf8");
    assert.match(calls, /release edit v0\.1\.0/);
    assert.match(calls, /--draft=false/);
    assert.match(calls, /--prerelease=false/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
