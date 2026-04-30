import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function runOrchestrateHandoff(env: Record<string, string>): {
  status: number | null;
  stderr: string;
  stdout: string;
  outputs: Map<string, string>;
  ghLog: string;
  dispatchPayload: Record<string, unknown> | null;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-orchestrate-handoff-"));
  try {
    const fakeGh = join(tempDir, "gh");
    const outputPath = join(tempDir, "github-output.txt");
    const ghLogPath = join(tempDir, "gh.log");
    const dispatchPayloadPath = join(tempDir, "dispatch.json");
    const plannerResponsePath = join(tempDir, "planner-response.md");

    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"

if [ "\${1-}" = "pr" ] && [ "\${2-}" = "view" ]; then
  if [ "\${FAKE_PR_STATUS_MODE-}" = "missing" ]; then
    exit 1
  fi
  printf '{"state":"%s","reviewDecision":"%s"}\\n' "\${FAKE_PR_STATE-OPEN}" "\${FAKE_PR_REVIEW_DECISION-}"
  exit 0
fi

if [ "\${1-}" = "api" ] && [ "\${2-}" = "--paginate" ] && [ "\${3-}" = "--slurp" ]; then
  printf '[]\\n'
  exit 0
fi

if [ "\${1-}" = "api" ] && [ "\${2-}" = "--method" ] && [ "\${3-}" = "POST" ] && [[ "\${4-}" == repos/*/issues/*/comments ]]; then
  printf '%s\\n' "\${FAKE_MARKER_ID-9001}"
  exit 0
fi

if [ "\${1-}" = "api" ] && [ "\${2-}" = "--method" ] && [ "\${3-}" = "PATCH" ] && [[ "\${4-}" == repos/*/issues/comments/* ]]; then
  exit 0
fi

if [ "\${1-}" = "api" ] && [ "\${2-}" = "-X" ] && [ "\${3-}" = "POST" ] && [[ "\${4-}" == repos/*/actions/workflows/*/dispatches ]]; then
  cat > "$FAKE_DISPATCH_PAYLOAD"
  exit 0
fi

printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const plannerResponse = env.PLANNER_RESPONSE || "";
    if (plannerResponse) {
      writeFileSync(plannerResponsePath, plannerResponse, "utf8");
    }
    const { PLANNER_RESPONSE: _plannerResponse, ...runEnv } = env;

    const result = spawnSync("node", [".agent/dist/cli/orchestrate-handoff.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_OUTPUT: outputPath,
        GH_TOKEN: "fake-token",
        GITHUB_REPOSITORY: "self-evolving/repo",
        DEFAULT_BRANCH: "main",
        SOURCE_ACTION: "orchestrate",
        SOURCE_CONCLUSION: "requested",
        SOURCE_RUN_ID: "12345",
        TARGET_KIND: "issue",
        TARGET_NUMBER: "20",
        REQUESTED_BY: "lolipopshock",
        REQUEST_TEXT: "@sepo-agent /orchestrate",
        AUTOMATION_MODE: "heuristics",
        AUTOMATION_CURRENT_ROUND: "1",
        AUTOMATION_MAX_ROUNDS: "5",
        AUTHOR_ASSOCIATION: "MEMBER",
        REPOSITORY_PRIVATE: "true",
        FAKE_GH_LOG: ghLogPath,
        FAKE_DISPATCH_PAYLOAD: dispatchPayloadPath,
        PLANNER_RESPONSE_FILE: plannerResponse ? plannerResponsePath : "",
        ...runEnv,
      },
      encoding: "utf8",
    });

    let ghLog = "";
    if (existsSync(ghLogPath)) {
      try {
        ghLog = readFileSync(ghLogPath, "utf8");
      } catch {
        ghLog = "";
      }
    }
    let dispatchPayload: Record<string, unknown> | null = null;
    if (existsSync(dispatchPayloadPath)) {
      try {
        dispatchPayload = JSON.parse(readFileSync(dispatchPayloadPath, "utf8"));
      } catch {
        dispatchPayload = null;
      }
    }

    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      outputs: parseGithubOutput(outputPath),
      ghLog,
      dispatchPayload,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("manual orchestrate stops when round budget is exhausted", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_CURRENT_ROUND: "5",
    AUTOMATION_MAX_ROUNDS: "5",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "automation round budget exhausted");
});

test("manual orchestrate stops for unsupported target kind", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "discussion",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "unsupported target kind discussion");
});

test("manual orchestrate stops when PR status cannot be read", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "21",
    FAKE_PR_STATUS_MODE: "missing",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "could not read pull request status");
});

test("manual orchestrate stops for non-open PR targets", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "21",
    FAKE_PR_STATE: "CLOSED",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "pull request is closed");
});

test("manual orchestrate dispatches implement for issue targets", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "20",
    BASE_PR: "12",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "implement");
  assert.match(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
  assert.equal((run.dispatchPayload?.inputs as Record<string, string>).base_pr, "12");
});

test("agent planner dispatches a child orchestrator lane", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "51",
    AUTOMATION_MODE: "agent",
    ORCHESTRATOR_LANE: "meta",
    ORCHESTRATION_CHAIN_ID: "issue-51",
    PLANNER_RESPONSE: JSON.stringify({
      decision: "handoff",
      next_action: "orchestrate",
      target_number: "51",
      orchestrator_lane: "stage-1",
      reason: "split the first stage into a child lane",
      handoff_context: "Implement stage 1, then report completion.",
    }),
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "orchestrate");
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.automation_mode, "heuristics");
  assert.equal(inputs.source_action, "orchestrate");
  assert.equal(inputs.orchestrator_lane, "stage-1");
  assert.equal(inputs.parent_orchestrator_lane, "meta");
  assert.equal(inputs.orchestration_chain_id, "issue-51");
  assert.equal(inputs.orchestrator_context, "Implement stage 1, then report completion.");
});

test("agent planner must name a child orchestrator lane", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "51",
    AUTOMATION_MODE: "agent",
    PLANNER_RESPONSE: JSON.stringify({
      decision: "handoff",
      next_action: "orchestrate",
      target_number: "51",
      reason: "missing lane",
    }),
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "agent planner requested orchestrate without orchestrator_lane");
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent planner malformed output stops manual orchestrate", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "51",
    AUTOMATION_MODE: "agent",
    PLANNER_RESPONSE: "not json",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "agent planner decision missing or invalid");
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
});

test("child orchestrator context is passed to implement dispatch", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "51",
    AUTOMATION_MODE: "heuristics",
    ORCHESTRATOR_LANE: "stage-1",
    PARENT_ORCHESTRATOR_LANE: "meta",
    ORCHESTRATION_CHAIN_ID: "issue-51",
    ORCHESTRATOR_CONTEXT: "Implement stage 1 only.",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "implement");
  assert.match(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.orchestrator_lane, "stage-1");
  assert.equal(inputs.parent_orchestrator_lane, "meta");
  assert.equal(inputs.orchestration_chain_id, "issue-51");
  assert.equal(inputs.orchestrator_context, "Implement stage 1 only.");
  assert.equal(inputs.orchestrator_target_kind, "issue");
  assert.equal(inputs.orchestrator_target_number, "51");
});

test("terminal child lane reports back to parent orchestrator", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "SHIP",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "61",
    AUTOMATION_MODE: "heuristics",
    ORCHESTRATOR_LANE: "stage-1",
    PARENT_ORCHESTRATOR_LANE: "meta",
    ORCHESTRATION_CHAIN_ID: "issue-51",
    ORCHESTRATOR_TARGET_KIND: "issue",
    ORCHESTRATOR_TARGET_NUMBER: "51",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.outputs.get("reason") || "", /review verdict is ship/i);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.automation_mode, "agent");
  assert.equal(inputs.source_action, "orchestrate");
  assert.equal(inputs.source_conclusion, "child_stop");
  assert.equal(inputs.target_kind, "issue");
  assert.equal(inputs.target_number, "51");
  assert.equal(inputs.orchestrator_lane, "meta");
  assert.equal(inputs.orchestration_chain_id, "issue-51");
  assert.match(inputs.orchestrator_context, /Child orchestrator lane stage-1 reached stop: review verdict is ship/i);
});

test("manual orchestrate dispatches fix-pr for PR targets with CHANGES_REQUESTED", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "21",
    FAKE_PR_STATE: "OPEN",
    FAKE_PR_REVIEW_DECISION: "CHANGES_REQUESTED",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "fix-pr");
  assert.match(run.ghLog, /actions\/workflows\/agent-fix-pr\.yml\/dispatches/);
});

test("manual orchestrate dispatches review for open PR targets without CHANGES_REQUESTED", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "21",
    FAKE_PR_STATE: "OPEN",
    FAKE_PR_REVIEW_DECISION: "APPROVED",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "review");
  assert.match(run.ghLog, /actions\/workflows\/agent-review\.yml\/dispatches/);
});

test("manual orchestrate re-validates delegated route access before dispatch", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "20",
    AUTHOR_ASSOCIATION: "CONTRIBUTOR",
    ACCESS_POLICY: JSON.stringify({
      route_overrides: {
        implement: ["MEMBER"],
      },
    }),
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "implement requests currently require MEMBER access.");
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
});
