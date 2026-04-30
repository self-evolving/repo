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
    const plannerResponse = env.FAKE_PLANNER_RESPONSE || "";
    const plannerResponsePath = join(tempDir, "planner-response.txt");
    if (plannerResponse) {
      writeFileSync(plannerResponsePath, plannerResponse, "utf8");
    }

    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"

if [ "\${1-}" = "pr" ] && [ "\${2-}" = "view" ] && [[ "$*" == *"--json body"* ]]; then
  printf '{"body":"%s"}\\n' "\${FAKE_PR_BODY-}"
  exit 0
fi

if [ "\${1-}" = "pr" ] && [ "\${2-}" = "view" ]; then
  if [ "\${FAKE_PR_STATUS_MODE-}" = "missing" ]; then
    exit 1
  fi
  printf '{"state":"%s","reviewDecision":"%s"}\\n' "\${FAKE_PR_STATE-OPEN}" "\${FAKE_PR_REVIEW_DECISION-}"
  exit 0
fi

if [ "\${1-}" = "issue" ] && [ "\${2-}" = "list" ]; then
  printf '%s\\n' "\${FAKE_ISSUE_LIST_JSON-[]}"
  exit 0
fi

if [ "\${1-}" = "issue" ] && [ "\${2-}" = "view" ]; then
  if [ -n "\${FAKE_ISSUE_VIEW_JSON-}" ]; then
    printf '%s\\n' "$FAKE_ISSUE_VIEW_JSON"
  else
    printf '{"number":20,"title":"Issue","body":""}\\n'
  fi
  exit 0
fi

if [ "\${1-}" = "issue" ] && [ "\${2-}" = "create" ]; then
  printf '%s\\n' "\${FAKE_CREATED_ISSUE_URL-https://github.com/self-evolving/repo/issues/77}"
  exit 0
fi

if [ "\${1-}" = "issue" ] && [ "\${2-}" = "edit" ]; then
  exit 0
fi

if [ "\${1-}" = "api" ] && [ "\${2-}" = "--paginate" ] && [ "\${3-}" = "--slurp" ]; then
  printf '%s\\n' "\${FAKE_ISSUE_COMMENTS_JSON-[]}"
  exit 0
fi

if [ "\${1-}" = "api" ] && [ "\${2-}" = "graphql" ]; then
  if [ "\${FAKE_GRAPHQL_MODE-}" = "error" ]; then
    printf '{"errors":[{"message":"graphql unavailable"}]}\\n'
    exit 0
  fi
  case "$*" in
    *ViewerLogin*)
      printf '{"data":{"viewer":{"login":"sepo-agent-app[bot]"}}}\\n'
      ;;
    *IssueGeneratedComments*)
      printf '{"data":{"repository":{"issue":{"comments":{"nodes":%s,"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}\\n' "\${FAKE_GRAPHQL_ISSUE_COMMENTS-[]}"
      ;;
    *PullRequestReviewSummaryComments*)
      printf '{"data":{"repository":{"pullRequest":{"comments":{"nodes":%s,"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}\\n' "\${FAKE_GRAPHQL_PR_COMMENTS-[]}"
      ;;
    *MinimizeReviewSummary*)
      printf '{"data":{"minimizeComment":{"minimizedComment":{"isMinimized":true}}}}\\n'
      ;;
    *)
      printf 'unexpected graphql query: %s\\n' "$*" >&2
      exit 1
      ;;
  esac
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
  if [ "\${FAKE_DISPATCH_MODE-}" = "fail" ]; then
    printf 'dispatch failed\\n' >&2
    exit 1
  fi
  cat > "$FAKE_DISPATCH_PAYLOAD"
  exit 0
fi

printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

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
        PLANNER_RESPONSE_FILE: plannerResponse ? plannerResponsePath : "",
        AUTHOR_ASSOCIATION: "MEMBER",
        REPOSITORY_PRIVATE: "true",
        FAKE_GH_LOG: ghLogPath,
        FAKE_DISPATCH_PAYLOAD: dispatchPayloadPath,
        ...env,
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

test("manual orchestrate collapses old handoff comments after dispatch", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "20",
    FAKE_MARKER_ID: "current-handoff",
    FAKE_GRAPHQL_ISSUE_COMMENTS: JSON.stringify([
      {
        id: "old-handoff",
        body: "<!-- sepo-agent-handoff state:dispatched created:123 base64:aGFuZG9m -->",
        isMinimized: false,
        author: { login: "sepo-agent-app" },
      },
      {
        id: "current-handoff",
        body: "<!-- sepo-agent-handoff state:dispatched created:456 base64:Y3VycmVudA -->",
        isMinimized: false,
        author: { login: "sepo-agent-app" },
      },
    ]),
  });

  assert.equal(run.status, 0);
  assert.match(run.stdout, /Collapsed 1 previous orchestrator handoff comment/);
  assert.match(run.ghLog, /id=old-handoff/);
  assert.doesNotMatch(run.ghLog, /id=current-handoff/);
});

test("manual orchestrate skips handoff cleanup when disabled", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "20",
    AGENT_COLLAPSE_OLD_REVIEWS: "false",
  });

  assert.equal(run.status, 0);
  assert.doesNotMatch(run.ghLog, /graphql/);
});

test("manual orchestrate keeps dispatch when handoff cleanup fails", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "20",
    FAKE_GRAPHQL_MODE: "error",
  });

  assert.equal(run.status, 0);
  assert.match(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
  assert.match(run.stderr, /Failed to collapse previous orchestrator handoff comments/);
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

test("agent meta orchestrate creates child issue and dispatches normal child orchestrator", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "51",
    AUTOMATION_MODE: "agent",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "handoff",
      next_action: "orchestrate",
      reason: "Split out the first stage.",
      child_stage: "stage-1",
      child_instructions: "Implement the first stage only.",
      base_pr: "12",
    }),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "orchestrate");
  assert.equal(run.outputs.get("target_number"), "77");
  assert.match(run.ghLog, /issue create/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.source_action, "orchestrate");
  assert.equal(inputs.target_kind, "issue");
  assert.equal(inputs.target_number, "77");
  assert.equal(inputs.automation_mode, "heuristics");
  assert.equal(inputs.base_pr, "12");
});

test("agent meta orchestrate can reuse an existing child issue", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "51",
    AUTOMATION_MODE: "agent",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "handoff",
      next_action: "orchestrate",
      reason: "Continue the existing child issue.",
      child_stage: "stage-1",
      child_issue_number: "88",
    }),
    FAKE_ISSUE_VIEW_JSON: JSON.stringify({
      number: 88,
      title: "Existing child",
      body: "<!-- sepo-sub-orchestrator parent:51 stage:stage-1 state:running -->",
    }),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.outputs.get("target_number"), "88");
  assert.match(run.ghLog, /issue view 88/);
  assert.doesNotMatch(run.ghLog, /issue edit 88/);
  assert.doesNotMatch(run.ghLog, /issue create/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.target_number, "88");
});

test("agent meta orchestrate rejects mismatched reusable child issue markers", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "51",
    AUTOMATION_MODE: "agent",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "handoff",
      next_action: "orchestrate",
      reason: "Continue the existing child issue.",
      child_stage: "stage-1",
      child_issue_number: "88",
    }),
    FAKE_ISSUE_VIEW_JSON: JSON.stringify({
      number: 88,
      title: "Wrong child",
      body: "<!-- sepo-sub-orchestrator parent:52 stage:stage-1 state:running -->",
    }),
  });

  assert.equal(run.status, 2);
  assert.match(run.stderr, /belongs to parent #52, not #51/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent meta orchestrate validates effective child base inputs", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "51",
    AUTOMATION_MODE: "agent",
    BASE_BRANCH: "agent/base",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "handoff",
      next_action: "orchestrate",
      reason: "Split out the first stage.",
      child_stage: "stage-1",
      child_instructions: "Implement the first stage only.",
      base_pr: "12",
    }),
  });

  assert.equal(run.status, 2);
  assert.match(run.stderr, /set only one of base_branch or base_pr/);
  assert.doesNotMatch(run.ghLog, /issue create/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent meta orchestrate reuses child found by parsed marker lookup", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "51",
    AUTOMATION_MODE: "agent",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "handoff",
      next_action: "orchestrate",
      reason: "Split out the first stage.",
      child_stage: "Stage 1",
      child_instructions: "Implement the first stage only.",
    }),
    FAKE_ISSUE_LIST_JSON: JSON.stringify([
      {
        number: 89,
        body: "<!-- sepo-sub-orchestrator parent:51 stage:stage-1 state:running -->",
      },
    ]),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.outputs.get("target_number"), "89");
  assert.match(run.ghLog, /issue list/);
  assert.match(run.ghLog, /--search sepo-sub-orchestrator/);
  assert.doesNotMatch(run.ghLog, /issue create/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.target_number, "89");
});

test("PR terminal SHIP resolves child issue and resumes parent orchestrator", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "SHIP",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "99",
    AUTOMATION_MODE: "heuristics",
    FAKE_PR_BODY: "Closes #77",
    FAKE_ISSUE_VIEW_JSON: JSON.stringify({
      number: 77,
      title: "Child",
      body: "Parent issue: #51\n\n<!-- sepo-sub-orchestrator parent:51 stage:stage-1 state:running -->",
    }),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "review verdict is SHIP");
  assert.match(run.ghLog, /pr view 99/);
  assert.match(run.ghLog, /issue view 77/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/51\/comments/);
  assert.match(run.ghLog, /issue edit 77/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.source_action, "orchestrate");
  assert.equal(inputs.target_kind, "issue");
  assert.equal(inputs.target_number, "51");
  assert.equal(inputs.automation_mode, "agent");
  assert.match(inputs.request_text, /Child issue #77 finished with SHIP/);
});

test("terminal child report keeps marker running when parent resume dispatch fails", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "SHIP",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "99",
    AUTOMATION_MODE: "heuristics",
    FAKE_PR_BODY: "Closes #77",
    FAKE_DISPATCH_MODE: "fail",
    FAKE_ISSUE_VIEW_JSON: JSON.stringify({
      number: 77,
      title: "Child",
      body: "Parent issue: #51\n\n<!-- sepo-sub-orchestrator parent:51 stage:stage-1 state:running -->",
    }),
  });

  assert.equal(run.status, 0);
  assert.match(run.stderr, /Failed to report terminal sub-orchestration state/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/51\/comments/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  assert.doesNotMatch(run.ghLog, /issue edit 77/);
});

test("terminal child report is idempotent after parent resume was dispatched", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "SHIP",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "99",
    AUTOMATION_MODE: "heuristics",
    FAKE_PR_BODY: "Closes #77",
    FAKE_ISSUE_VIEW_JSON: JSON.stringify({
      number: 77,
      title: "Child",
      body: "Parent issue: #51\n\n<!-- sepo-sub-orchestrator parent:51 stage:stage-1 state:running -->",
    }),
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([[
      {
        id: 123,
        body: "<!-- sepo-sub-orchestrator-report child:77 resume:dispatched -->",
      },
    ]]),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  assert.match(run.ghLog, /issue edit 77/);
});
