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

function runPreflight(env: Record<string, string>): Map<string, string> {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-orchestrator-preflight-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/orchestrator-preflight.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    return parseGithubOutput(outputPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("orchestrator preflight skips planner for terminal agent outcomes", () => {
  const unsupported = runPreflight({
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "1",
    AUTOMATION_MAX_ROUNDS: "5",
    SOURCE_ACTION: "fix-pr",
    SOURCE_CONCLUSION: "unsupported",
    TARGET_NUMBER: "99",
  });
  const failed = runPreflight({
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "1",
    AUTOMATION_MAX_ROUNDS: "5",
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "failed",
    TARGET_NUMBER: "99",
  });

  assert.equal(unsupported.get("planner_enabled"), "false");
  assert.equal(failed.get("planner_enabled"), "false");
});

test("orchestrator preflight enables planner for agent handoff candidates", () => {
  const outputs = runPreflight({
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "1",
    AUTOMATION_MAX_ROUNDS: "5",
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "minor_issues",
    TARGET_NUMBER: "99",
  });

  assert.equal(outputs.get("planner_enabled"), "true");
});
