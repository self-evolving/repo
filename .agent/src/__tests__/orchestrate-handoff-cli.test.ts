import { execFileSync, spawnSync } from "node:child_process";
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

function writeFakeGh(path: string, logPath: string): void {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      "if [[ \"$1\" == \"api\" && \"${2:-}\" == \"--paginate\" && \"${3:-}\" == \"repos/self-evolving/repo/issues/99/labels\" ]]; then",
      "  if [[ \"${FAKE_LABEL_PRESENT:-}\" == \"true\" ]]; then echo 'agent-auto-running'; fi",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == \"api\" && \"${2:-}\" == \"--paginate\" ]]; then",
      "  echo '[]'",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == \"api\" && \"${2:-}\" == \"--method\" && \"${3:-}\" == \"POST\" && \"$*\" == *'/comments '* ]]; then",
      "  echo '123'",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == \"label\" && \"${2:-}\" == \"list\" ]]; then",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == \"label\" && \"${2:-}\" == \"create\" ]]; then",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == \"api\" && \"${2:-}\" == \"--method\" && \"${3:-}\" == \"POST\" && \"$*\" == *'/labels '* ]]; then",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == \"api\" && \"${2:-}\" == \"-X\" && \"${3:-}\" == \"POST\" ]]; then",
      "  if [[ \"${FAKE_DISPATCH_FAIL:-}\" == \"true\" ]]; then echo 'dispatch failed' >&2; exit 1; fi",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == \"api\" && \"${2:-}\" == \"--method\" && \"${3:-}\" == \"PATCH\" ]]; then",
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

test("orchestrate-handoff stops later handoffs when automation label is absent", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-orchestrate-handoff-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const logPath = join(tempDir, "gh.log");
    const fakeGh = join(tempDir, "gh");
    writeFakeGh(fakeGh, logPath);
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(logPath, "", "utf8");

    const stdout = execFileSync("node", [".agent/dist/cli/orchestrate-handoff.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        DEFAULT_BRANCH: "main",
        AUTOMATION_MODE: "heuristics",
        AUTOMATION_CURRENT_ROUND: "2",
        AUTOMATION_MAX_ROUNDS: "5",
        SOURCE_ACTION: "review",
        SOURCE_CONCLUSION: "minor_issues",
        SOURCE_RUN_ID: "run-1",
        TARGET_NUMBER: "99",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8");

    const outputs = parseGithubOutput(outputPath);
    const ghLog = readFileSync(logPath, "utf8");

    assert.equal(outputs.get("decision"), "stop");
    assert.match(outputs.get("reason") || "", /agent-auto-running is absent/);
    assert.match(stdout, /Handoff stop/);
    assert.doesNotMatch(ghLog, /actions\/workflows\/agent-fix-pr\.yml\/dispatches/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("orchestrate-handoff dispatches later handoffs when paginated automation label is present", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-orchestrate-handoff-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const logPath = join(tempDir, "gh.log");
    const fakeGh = join(tempDir, "gh");
    writeFakeGh(fakeGh, logPath);
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(logPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/orchestrate-handoff.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        FAKE_LABEL_PRESENT: "true",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        DEFAULT_BRANCH: "main",
        AUTOMATION_MODE: "heuristics",
        AUTOMATION_CURRENT_ROUND: "2",
        AUTOMATION_MAX_ROUNDS: "5",
        SOURCE_ACTION: "review",
        SOURCE_CONCLUSION: "minor_issues",
        SOURCE_RUN_ID: "run-1",
        TARGET_NUMBER: "99",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outputs = parseGithubOutput(outputPath);
    const ghLog = readFileSync(logPath, "utf8");

    assert.equal(outputs.get("decision"), "dispatch");
    assert.match(ghLog, /api --paginate repos\/self-evolving\/repo\/issues\/99\/labels --jq \.\[\]\.name/);
    assert.doesNotMatch(ghLog, /label create agent-auto-running/);
    assert.doesNotMatch(ghLog, /repos\/self-evolving\/repo\/issues\/99\/labels -f labels\[\]=agent-auto-running/);
    assert.match(ghLog, /actions\/workflows\/agent-fix-pr\.yml\/dispatches/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("orchestrate-handoff adds automation label before first dispatch", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-orchestrate-handoff-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const logPath = join(tempDir, "gh.log");
    const fakeGh = join(tempDir, "gh");
    writeFakeGh(fakeGh, logPath);
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(logPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/orchestrate-handoff.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        DEFAULT_BRANCH: "main",
        AUTOMATION_MODE: "heuristics",
        AUTOMATION_CURRENT_ROUND: "1",
        AUTOMATION_MAX_ROUNDS: "5",
        SOURCE_ACTION: "review",
        SOURCE_CONCLUSION: "minor_issues",
        SOURCE_RUN_ID: "run-1",
        TARGET_NUMBER: "99",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outputs = parseGithubOutput(outputPath);
    const ghLog = readFileSync(logPath, "utf8");

    assert.equal(outputs.get("decision"), "dispatch");
    assert.match(ghLog, /label create agent-auto-running/);
    assert.match(ghLog, /repos\/self-evolving\/repo\/issues\/99\/labels -f labels\[\]=agent-auto-running/);
    assert.match(ghLog, /actions\/workflows\/agent-fix-pr\.yml\/dispatches/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("orchestrate-handoff removes a newly added automation label when first dispatch fails", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-orchestrate-handoff-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const logPath = join(tempDir, "gh.log");
    const fakeGh = join(tempDir, "gh");
    writeFakeGh(fakeGh, logPath);
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(logPath, "", "utf8");

    const result = spawnSync("node", [".agent/dist/cli/orchestrate-handoff.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        FAKE_DISPATCH_FAIL: "true",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        DEFAULT_BRANCH: "main",
        AUTOMATION_MODE: "heuristics",
        AUTOMATION_CURRENT_ROUND: "1",
        AUTOMATION_MAX_ROUNDS: "5",
        SOURCE_ACTION: "review",
        SOURCE_CONCLUSION: "minor_issues",
        SOURCE_RUN_ID: "run-1",
        TARGET_NUMBER: "99",
      },
      encoding: "utf8",
    });

    const outputs = parseGithubOutput(outputPath);
    const ghLog = readFileSync(logPath, "utf8");

    assert.notEqual(result.status, 0);
    assert.equal(outputs.get("decision"), "dispatch");
    assert.match(ghLog, /label create agent-auto-running/);
    assert.match(ghLog, /repos\/self-evolving\/repo\/issues\/99\/labels -f labels\[\]=agent-auto-running/);
    assert.match(ghLog, /actions\/workflows\/agent-fix-pr\.yml\/dispatches/);
    assert.match(ghLog, /api --method DELETE repos\/self-evolving\/repo\/issues\/99\/labels\/agent-auto-running/);
    assert.match(ghLog, /api --method PATCH repos\/self-evolving\/repo\/issues\/comments\/123/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
