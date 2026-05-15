import { spawnSync } from "node:child_process";
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

function runPreflight(env: Record<string, string>): {
  status: number | null;
  stderr: string;
  stdout: string;
  outputs: Map<string, string>;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-orchestrator-preflight-"));
  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");
    const result = spawnSync("node", [".agent/dist/cli/orchestrator-preflight.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        AUTOMATION_MODE: "agent",
        AUTOMATION_CURRENT_ROUND: "1",
        AUTOMATION_MAX_ROUNDS: "5",
        SOURCE_ACTION: "orchestrate",
        SOURCE_CONCLUSION: "requested",
        TARGET_KIND: "issue",
        AUTHOR_ASSOCIATION: "MEMBER",
        REPOSITORY_PRIVATE: "true",
        ...env,
      },
      encoding: "utf8",
    });

    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      outputs: parseGithubOutput(outputPath),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("preflight disables planner when initial orchestrate lacks delegated route access", () => {
  const run = runPreflight({
    AUTHOR_ASSOCIATION: "CONTRIBUTOR",
    ACCESS_POLICY: JSON.stringify({
      route_overrides: {
        implement: ["MEMBER"],
      },
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("planner_enabled"), "false");
  assert.equal(run.outputs.get("authorization_stop"), "true");
  assert.equal(
    run.outputs.get("authorization_stop_reason"),
    "orchestrate requests require implement access; implement currently requires MEMBER access.",
  );
});

test("preflight keeps planner enabled for authorized issue meta-orchestration", () => {
  const run = runPreflight({});

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("planner_enabled"), "true");
  assert.equal(run.outputs.get("authorization_stop"), "false");
});

test("preflight defaults automation max rounds to 12", () => {
  const run = runPreflight({ AUTOMATION_MAX_ROUNDS: "" });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("max_rounds"), "12");
  assert.equal(run.outputs.get("planner_enabled"), "true");
});

test("preflight checks self-approval delegated access only when enabled", () => {
  const accessPolicy = JSON.stringify({
    route_overrides: {
      "agent-self-approve": ["MEMBER"],
    },
  });
  const disabled = runPreflight({
    AUTHOR_ASSOCIATION: "CONTRIBUTOR",
    ACCESS_POLICY: accessPolicy,
    REPOSITORY_PRIVATE: "false",
    AGENT_ALLOW_SELF_APPROVE: "false",
  });
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  assert.equal(disabled.outputs.get("authorization_stop"), "false");

  const enabled = runPreflight({
    AUTHOR_ASSOCIATION: "CONTRIBUTOR",
    ACCESS_POLICY: accessPolicy,
    REPOSITORY_PRIVATE: "false",
    AGENT_ALLOW_SELF_APPROVE: "true",
  });
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  assert.equal(enabled.outputs.get("authorization_stop"), "true");
  assert.equal(
    enabled.outputs.get("authorization_stop_reason"),
    "orchestrate requests require agent-self-approve access; agent-self-approve currently requires MEMBER access.",
  );
});

test("preflight checks self-merge delegated access only when enabled", () => {
  const accessPolicy = JSON.stringify({
    route_overrides: {
      "agent-self-merge": ["MEMBER"],
    },
  });
  const disabled = runPreflight({
    AUTHOR_ASSOCIATION: "CONTRIBUTOR",
    ACCESS_POLICY: accessPolicy,
    REPOSITORY_PRIVATE: "false",
    AGENT_ALLOW_SELF_APPROVE: "true",
    AGENT_ALLOW_SELF_MERGE: "false",
  });
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  assert.equal(disabled.outputs.get("authorization_stop"), "false");

  const enabled = runPreflight({
    AUTHOR_ASSOCIATION: "CONTRIBUTOR",
    ACCESS_POLICY: accessPolicy,
    REPOSITORY_PRIVATE: "false",
    AGENT_ALLOW_SELF_APPROVE: "true",
    AGENT_ALLOW_SELF_MERGE: "true",
  });
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  assert.equal(enabled.outputs.get("authorization_stop"), "true");
  assert.equal(
    enabled.outputs.get("authorization_stop_reason"),
    "orchestrate requests require agent-self-merge access; agent-self-merge currently requires MEMBER access.",
  );
});

test("preflight keeps planner enabled for authorized PR orchestration", () => {
  const run = runPreflight({
    TARGET_KIND: "pull_request",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("planner_enabled"), "true");
  assert.equal(run.outputs.get("authorization_stop"), "false");
});
