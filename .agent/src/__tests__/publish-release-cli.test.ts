import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runGit(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function commitReleaseFiles(workspace: string, message: string): string {
  runGit(workspace, ["add", ".agent/package.json", ".agent/CHANGELOG.md"]);
  runGit(workspace, ["commit", "-m", message]);
  return runGit(workspace, ["rev-parse", "HEAD"]);
}

function initReleaseRepo(workspace: string, version = "0.4.0"): string {
  mkdirSync(workspace);
  runGit(workspace, ["init"]);
  runGit(workspace, ["config", "user.name", "Sepo Test"]);
  runGit(workspace, ["config", "user.email", "sepo-test@example.com"]);
  writeReleaseFiles(workspace, version);
  return commitReleaseFiles(workspace, `release ${version}`);
}

function writeReleaseFiles(workspace: string, version = "0.4.0"): void {
  mkdirSync(join(workspace, ".agent"), { recursive: true });
  writeFileSync(
    join(workspace, ".agent/package.json"),
    JSON.stringify({ name: "@self-evolving/sepo", version }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(workspace, ".agent/CHANGELOG.md"),
    [
      "# Changelog",
      "",
      `## ${version} - 2026-06-04`,
      "",
      "### Added",
      "",
      "- Publish release workflow.",
      "",
      "## 0.3.1 - 2026-06-04",
      "",
      "### Fixed",
      "",
      "- Prior release.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeFakeGh(tempDir: string, mode: "eligible" | "unmarked" | "publish", targetSha: string): string {
  const callsPath = join(tempDir, "gh-calls.txt");
  writeFileSync(callsPath, "", "utf8");
  const prBody = mode === "unmarked" ? "## Summary" : "## Summary <!-- sepo-agent-release-pr -->";
  writeFileSync(
    join(tempDir, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"body":"${prBody}","state":"MERGED","mergedAt":"2026-06-04T00:00:00Z","mergeCommit":{"oid":"${targetSha}"},"files":[{"path":".agent/package.json"},{"path":".agent/CHANGELOG.md"}]}\\n'
  exit 0
fi
if [ "$1" = "api" ]; then
  printf 'HTTP 404: Not Found\\n' >&2
  exit 1
fi
if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  printf 'https://github.com/self-evolving/repo/releases/tag/v0.4.0\\n'
  exit 0
fi
exit 1
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return callsPath;
}

test("publish-release dry-run validates release PR marker and files", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-publish-release-"));
  try {
    const workspace = join(tempDir, "workspace");
    const targetSha = initReleaseRepo(workspace);
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");
    const callsPath = writeFakeGh(tempDir, "eligible", targetSha);

    execFileSync("node", [".agent/dist/cli/publish-release.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: join(tempDir, "summary.md"),
        GITHUB_REPOSITORY: "self-evolving/repo",
        GITHUB_WORKSPACE: workspace,
        PR_NUMBER: "51",
        TARGET_SHA: targetSha,
        DRY_RUN: "true",
        RUNNER_TEMP: tempDir,
      },
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("conclusion"), "dry-run");
    assert.equal(outputs.get("tag"), "v0.4.0");
    assert.equal(outputs.get("target_sha"), targetSha);

    const calls = readFileSync(callsPath, "utf8");
    assert.match(calls, /pr view 51/);
    assert.match(calls, /api repos\/self-evolving\/repo\/git\/ref\/tags\/v0\.4\.0/);
    assert.doesNotMatch(calls, /release create/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publish-release skips merged PRs without the release marker", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-publish-release-"));
  try {
    const workspace = join(tempDir, "workspace");
    const targetSha = initReleaseRepo(workspace);
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");
    const callsPath = writeFakeGh(tempDir, "unmarked", targetSha);

    execFileSync("node", [".agent/dist/cli/publish-release.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: join(tempDir, "summary.md"),
        GITHUB_REPOSITORY: "self-evolving/repo",
        GITHUB_WORKSPACE: workspace,
        PR_NUMBER: "52",
        TARGET_SHA: targetSha,
        RUNNER_TEMP: tempDir,
      },
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("conclusion"), "skipped");
    assert.match(outputs.get("reason") || "", /not marked as a Sepo release PR/);

    const calls = readFileSync(callsPath, "utf8");
    assert.doesNotMatch(calls, /release create/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publish-release creates a GitHub Release for manual recovery", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-publish-release-"));
  try {
    const workspace = join(tempDir, "workspace");
    const targetSha = initReleaseRepo(workspace);
    writeReleaseFiles(workspace, "0.4.1");
    commitReleaseFiles(workspace, "move default branch forward");
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");
    const callsPath = writeFakeGh(tempDir, "publish", targetSha);

    execFileSync("node", [".agent/dist/cli/publish-release.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: join(tempDir, "summary.md"),
        GITHUB_REPOSITORY: "self-evolving/repo",
        GITHUB_WORKSPACE: workspace,
        TARGET_SHA: targetSha,
        VERSION: "0.4.0",
        RUNNER_TEMP: tempDir,
      },
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("conclusion"), "published");
    assert.equal(outputs.get("release_url"), "https://github.com/self-evolving/repo/releases/tag/v0.4.0");

    const calls = readFileSync(callsPath, "utf8");
    assert.match(calls, /release create v0\.4\.0/);
    assert.match(calls, new RegExp(`--target ${targetSha}`));
    assert.match(calls, /--notes-file/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publish-release rejects manual target SHAs outside trusted default history", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-publish-release-"));
  try {
    const workspace = join(tempDir, "workspace");
    initReleaseRepo(workspace);
    const defaultBranch = runGit(workspace, ["branch", "--show-current"]);
    runGit(workspace, ["checkout", "-b", "untrusted-target"]);
    writeReleaseFiles(workspace, "0.4.1");
    const untrustedSha = commitReleaseFiles(workspace, "unmerged release target");
    runGit(workspace, ["checkout", defaultBranch]);
    const callsPath = writeFakeGh(tempDir, "publish", untrustedSha);

    const result = spawnSync("node", [".agent/dist/cli/publish-release.js"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        GITHUB_WORKSPACE: workspace,
        TARGET_SHA: untrustedSha,
        VERSION: "0.4.1",
        RUNNER_TEMP: tempDir,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not reachable from the checked-out trusted HEAD/);
    assert.equal(readFileSync(callsPath, "utf8"), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("publish-release rejects requested versions that do not match package version", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-publish-release-"));
  try {
    const workspace = join(tempDir, "workspace");
    const targetSha = initReleaseRepo(workspace);
    const callsPath = writeFakeGh(tempDir, "publish", targetSha);

    const result = spawnSync("node", [".agent/dist/cli/publish-release.js"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GH_CALLS: callsPath,
        GITHUB_STEP_SUMMARY: join(tempDir, "summary.md"),
        GITHUB_REPOSITORY: "self-evolving/repo",
        GITHUB_WORKSPACE: workspace,
        TARGET_SHA: targetSha,
        VERSION: "0.4.1",
        RUNNER_TEMP: tempDir,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /requested version 0\.4\.1 does not match/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
