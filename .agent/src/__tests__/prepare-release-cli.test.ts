import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("prepare-release reuses an open release issue for the same version", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-prepare-release-"));
  try {
    const outputPath = join(tempDir, "github-output.txt");
    const callsPath = join(tempDir, "gh-calls.txt");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(callsPath, "", "utf8");
    writeFileSync(
      join(tempDir, "gh"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '[{"number":42,"title":"Prepare Sepo release 0.2.0","url":"https://github.com/self-evolving/repo/issues/42"}]\\n'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  echo "unexpected create" >&2
  exit 1
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/prepare-release.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        RUNNER_TEMP: tempDir,
        VERSION: "0.2.0",
      },
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("issue_number"), "42");
    assert.equal(outputs.get("issue_action"), "reused");
    assert.equal(outputs.get("version"), "0.2.0");
    assert.match(outputs.get("request_text") || "", /0\.2\.0/);

    const calls = readFileSync(callsPath, "utf8");
    assert.match(calls, /issue list/);
    assert.doesNotMatch(calls, /issue create/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepare-release emits created issue outputs from a valid create URL", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-prepare-release-"));
  try {
    const outputPath = join(tempDir, "github-output.txt");
    const callsPath = join(tempDir, "gh-calls.txt");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(callsPath, "", "utf8");
    writeFileSync(
      join(tempDir, "gh"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  printf 'https://github.com/self-evolving/repo/issues/77\\n'
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/prepare-release.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        RUNNER_TEMP: tempDir,
        VERSION: "0.2.0",
      },
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("issue_number"), "77");
    assert.equal(outputs.get("issue_action"), "created");
    assert.equal(outputs.get("issue_url"), "https://github.com/self-evolving/repo/issues/77");

    const bodyFile = readdirSync(tempDir).find((name) => /^release-prepare-[a-f0-9]+\.md$/.test(name));
    assert.ok(bodyFile);
    const issueBody = readFileSync(join(tempDir, bodyFile), "utf8");
    assert.match(issueBody, /`\.agent\/CHANGELOG\.md`/);

    const calls = readFileSync(callsPath, "utf8");
    assert.match(calls, /issue create/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepare-release fails clearly when a created issue URL has no issue number", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-prepare-release-"));
  try {
    const outputPath = join(tempDir, "github-output.txt");
    const callsPath = join(tempDir, "gh-calls.txt");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(callsPath, "", "utf8");
    writeFileSync(
      join(tempDir, "gh"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  printf 'https://github.com/self-evolving/repo/issues/not-a-number\\n'
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const result = spawnSync("node", [".agent/dist/cli/prepare-release.js"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        RUNNER_TEMP: tempDir,
        VERSION: "0.2.0",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not parse created release prepare issue number/);
    assert.equal(readFileSync(outputPath, "utf8"), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
