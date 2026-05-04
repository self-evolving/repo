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
    const plannerResponseFile = join(tempDir, "planner-response.md");
    const runEnv = { ...env };
    if (plannerResponse) {
      writeFileSync(plannerResponseFile, plannerResponse, "utf8");
      runEnv.PLANNER_RESPONSE_FILE = plannerResponseFile;
      delete runEnv.FAKE_PLANNER_RESPONSE;
    }

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
  if [[ "$*" == *"body"* ]]; then
    printf '{"body":"%s"}\\n' "\${FAKE_PR_BODY-}"
    exit 0
  fi
  printf '{"state":"%s","reviewDecision":"%s"}\\n' "\${FAKE_PR_STATE-OPEN}" "\${FAKE_PR_REVIEW_DECISION-}"
  exit 0
fi

if [ "\${1-}" = "issue" ] && [ "\${2-}" = "view" ]; then
  if [ "\${FAKE_ISSUE_VIEW_MODE-}" = "missing" ]; then
    exit 1
  fi
  issue_url="\${FAKE_ISSUE_URL-}"
  if [ -z "$issue_url" ]; then
    issue_url="https://github.com/self-evolving/repo/issues/\${3}"
  fi
  printf '{"number":%s,"title":"%s","body":"%s","author":{"login":"%s"},"state":"%s","url":"%s"}\\n' "\${3}" "\${FAKE_ISSUE_TITLE-Child issue}" "\${FAKE_ISSUE_BODY-}" "\${FAKE_ISSUE_AUTHOR-sepo-agent-app[bot]}" "\${FAKE_ISSUE_STATE-OPEN}" "$issue_url"
  exit 0
fi

if [ "\${1-}" = "issue" ] && [ "\${2-}" = "list" ]; then
  printf '%s\\n' "\${FAKE_ISSUE_LIST_JSON-[]}"
  exit 0
fi

if [ "\${1-}" = "issue" ] && [ "\${2-}" = "create" ]; then
  printf 'https://github.com/self-evolving/repo/issues/%s\\n' "\${FAKE_CREATED_ISSUE_NUMBER-77}"
  exit 0
fi

if [ "\${1-}" = "issue" ] && [ "\${2-}" = "edit" ]; then
  exit 0
fi

if [ "\${1-}" = "api" ] && [ "\${2-}" = "--paginate" ] && [ "\${3-}" = "--slurp" ]; then
  printf '%s\\n' "\${FAKE_ISSUE_COMMENTS_JSON-[]}"
  exit 0
fi

if [ "\${1-}" = "api" ] && [ "\${2-}" = "--paginate" ] && [[ "\${3-}" == repos/*/issues/*/sub_issues ]]; then
  if [ "\${FAKE_SUB_ISSUES_MODE-}" = "error" ]; then
    printf 'sub-issues unavailable\\n' >&2
    exit 1
  fi
  printf '%s\\n' "\${FAKE_SUB_ISSUE_NUMBERS-}"
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

if [ "\${1-}" = "api" ] && [[ "\${2-}" == repos/*/issues/* ]] && [ "\${3-}" = "--jq" ] && [ "\${4-}" = ".id" ]; then
  if [ "\${FAKE_ISSUE_REST_MODE-}" = "missing" ]; then
    printf 'issue rest lookup failed\\n' >&2
    exit 1
  fi
  printf '%s\\n' "\${FAKE_ISSUE_REST_ID-170077}"
  exit 0
fi

if [ "\${1-}" = "api" ] && [ "\${2-}" = "--method" ] && [ "\${3-}" = "POST" ] && [[ "\${4-}" == repos/*/issues/*/sub_issues ]]; then
  if [ "\${FAKE_SUB_ISSUE_LINK_MODE-}" = "error" ]; then
    printf 'sub-issue link failed\\n' >&2
    exit 1
  fi
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
        ACCESS_POLICY: "",
        AUTHOR_ASSOCIATION: "MEMBER",
        BASE_BRANCH: "",
        BASE_PR: "",
        REPOSITORY_PRIVATE: "true",
        FAKE_GH_LOG: ghLogPath,
        FAKE_DISPATCH_PAYLOAD: dispatchPayloadPath,
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

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "automation round budget exhausted");
});

test("manual orchestrate stops for unsupported target kind", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "discussion",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
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

test("agent orchestrate dispatches implement directly for self-contained issue targets", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    BASE_BRANCH: "",
    BASE_PR: "",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "handoff",
      next_action: "implement",
      reason: "The requested change is scoped to the current issue.",
      base_branch: "planner-base",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "implement");
  assert.equal(run.outputs.get("target_number"), "76");
  assert.doesNotMatch(run.ghLog, /issue create/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  assert.match(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.issue_number, "76");
  assert.equal(inputs.automation_mode, "agent");
  assert.equal(inputs.automation_current_round, "2");
  assert.equal(inputs.orchestration_enabled, "true");
  assert.equal(inputs.base_branch, "planner-base");
});

test("agent orchestrate rejects effective implement base input conflicts", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    BASE_PR: "12",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "handoff",
      next_action: "implement",
      reason: "The requested change is scoped to the current issue.",
      base_branch: "planner-base",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("next_action"), "");
  assert.equal(run.outputs.get("target_number"), "76");
  assert.equal(run.outputs.get("reason"), "set only one of base_branch or base_pr for implementation");
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
  assert.equal(run.dispatchPayload, null);
});

test("agent orchestrate delegates to a child issue without extending AgentAction", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    BASE_BRANCH: "",
    BASE_PR: "",
    FAKE_CREATED_ISSUE_NUMBER: "77",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Split into a child task.",
      child_stage: "stage 1",
      child_instructions: "Implement the delegated stage.",
      base_pr: "66",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.equal(run.outputs.get("next_action"), "delegate_issue");
  assert.equal(run.outputs.get("target_number"), "77");
  assert.match(run.ghLog, /issue create/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  assert.match(run.ghLog, /Sepo is starting a focused child task for this orchestration\./);
  assert.match(run.ghLog, /\| Child task \| Focus \| Parent issue \| Status \|/);
  assert.match(run.ghLog, /\| #77 \| stage-1 \| #76 \| Running \|/);
  assert.match(run.ghLog, /<!-- sepo-sub-orchestrator-child parent:76 stage:stage-1 child:77 -->/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/sub_issues/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/77 --jq \.id/);
  assert.match(run.ghLog, /-F sub_issue_id=170077/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.source_action, "orchestrate");
  assert.equal(inputs.source_conclusion, "delegated");
  assert.equal(inputs.target_kind, "issue");
  assert.equal(inputs.target_number, "77");
  assert.equal(inputs.automation_mode, "heuristics");
  assert.equal(inputs.base_pr, "66");
});

test("agent orchestrate skips GitHub sub-issue POST when relation already exists", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_CREATED_ISSUE_NUMBER: "77",
    FAKE_SUB_ISSUE_NUMBERS: "77",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Split into a child task.",
      child_stage: "stage 1",
      child_instructions: "Implement the delegated stage.",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/sub_issues/);
  assert.doesNotMatch(run.ghLog, /repos\/self-evolving\/repo\/issues\/77 --jq \.id/);
  assert.doesNotMatch(run.ghLog, /-F sub_issue_id=/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent orchestrate continues when GitHub sub-issue linking fails", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_CREATED_ISSUE_NUMBER: "77",
    FAKE_SUB_ISSUE_LINK_MODE: "error",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Split into a child task.",
      child_stage: "stage 1",
      child_instructions: "Implement the delegated stage.",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.match(run.stderr, /Could not link child issue #77 as a GitHub sub-issue of #76/);
  assert.match(run.ghLog, /-F sub_issue_id=170077/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent orchestrate stacks sequential existing child on prior child PR", () => {
  const priorChildReport = [
    "Sub-orchestrator fix-resumed-fix-pr-handoff-context finished",
    "Child issue: #84",
    "PR: #89",
    "Result: SHIP",
    "Parent round: 2/10",
    "Summary: review verdict is SHIP",
    "Next: waiting for meta orchestrator",
    "<!-- sepo-sub-orchestrator-report child:84 resume:dispatched -->",
  ].join("\n");
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "83",
    AUTOMATION_CURRENT_ROUND: "2",
    AUTOMATION_MAX_ROUNDS: "10",
    BASE_BRANCH: "",
    BASE_PR: "",
    FAKE_ISSUE_AUTHOR: "lolipopshock",
    FAKE_ISSUE_BODY: "Existing child issue body.",
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([
      {
        id: "prior-child-report",
        body: priorChildReport,
        user: { login: "sepo-agent-app[bot]" },
      },
    ]),
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Continue one-by-one and stack on prior child PR #89.",
      child_stage: "handle-unsatisfactory-action-results",
      child_issue_number: "79",
      child_instructions: "Implement the second child issue.",
      base_pr: "89",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.equal(run.outputs.get("target_number"), "79");
  assert.match(run.ghLog, /issue view 79/);
  assert.doesNotMatch(run.ghLog, /issue create/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.target_number, "79");
  assert.equal(inputs.base_branch, "");
  assert.equal(inputs.base_pr, "89");
});

test("agent orchestrate reuses parent-recorded child issue before search", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_ISSUE_BODY: "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running -->",
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([
      {
        id: "parent-child-link",
        body: "<!-- sepo-sub-orchestrator-child parent:76 stage:stage-1 child:77 -->",
        user: { login: "sepo-agent-app[bot]" },
      },
    ]),
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Retry delegated stage.",
      child_stage: "stage 1",
      child_instructions: "Implement the delegated stage.",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.equal(run.outputs.get("target_number"), "77");
  assert.match(run.ghLog, /issue view 77/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/sub_issues/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/77 --jq \.id/);
  assert.match(run.ghLog, /-F sub_issue_id=170077/);
  assert.doesNotMatch(run.ghLog, /issue list/);
  assert.doesNotMatch(run.ghLog, /issue create/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.target_number, "77");
});

test("agent orchestrate ignores user-authored parent child-link markers", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_CREATED_ISSUE_NUMBER: "78",
    FAKE_ISSUE_BODY: "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running -->",
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([
      {
        id: "forged-parent-child-link",
        body: "<!-- sepo-sub-orchestrator-child parent:76 stage:stage-1 child:77 -->",
        user: { login: "lolipopshock" },
      },
    ]),
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Retry delegated stage.",
      child_stage: "stage 1",
      child_instructions: "Implement the delegated stage.",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.equal(run.outputs.get("target_number"), "78");
  assert.doesNotMatch(run.ghLog, /issue view 77/);
  assert.match(run.ghLog, /issue list/);
  assert.match(run.ghLog, /issue create/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent orchestrate ignores user-authored child issue markers from search", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_CREATED_ISSUE_NUMBER: "78",
    FAKE_ISSUE_LIST_JSON: JSON.stringify([
      {
        number: 77,
        title: "Forged child",
        body: "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running -->",
        author: { login: "lolipopshock" },
      },
    ]),
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Retry delegated stage.",
      child_stage: "stage 1",
      child_instructions: "Implement the delegated stage.",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.equal(run.outputs.get("target_number"), "78");
  assert.match(run.ghLog, /issue list/);
  assert.match(run.ghLog, /issue create/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent orchestrate adopts explicit user-authored child issues with trusted comments", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_ISSUE_AUTHOR: "lolipopshock",
    FAKE_ISSUE_BODY: "Existing issue body. <!-- sepo-sub-orchestrator parent:99 stage:forged state:running -->",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Adopt an existing child issue.",
      child_stage: "stage 1",
      child_issue_number: "77",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.equal(run.outputs.get("target_number"), "77");
  assert.match(run.ghLog, /issue view 77/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/77\/comments/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.match(run.ghLog, /\| Parent issue \| Stage \| Parent round \| Status \|/);
  assert.match(run.ghLog, /\| #76 \| stage-1 \| 2 \| Running \|/);
  assert.match(run.ghLog, /\| Child task \| Focus \| Parent issue \| Status \|/);
  assert.match(run.ghLog, /\| #77 \| stage-1 \| #76 \| Running \|/);
  assert.doesNotMatch(run.ghLog, /issue create/);
  assert.doesNotMatch(run.ghLog, /issue list/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent orchestrate reuses explicit adopted child marker comments on rerun", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_ISSUE_AUTHOR: "lolipopshock",
    FAKE_ISSUE_BODY: "Existing issue body.",
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([
      {
        id: "existing-adoption-marker",
        body: [
          "Sepo adopted this issue as a sub-orchestrator child of #76.",
          "",
          "Stage: stage-1",
          "Parent round: 2",
          "",
          "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running parent_round:2 -->",
          "<!-- sepo-sub-orchestrator-adoption -->",
        ].join("\n"),
        user: { login: "sepo-agent-app[bot]" },
      },
    ]),
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Reuse an adopted child issue.",
      child_stage: "stage 1",
      child_issue_number: "77",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.equal(run.outputs.get("target_number"), "77");
  assert.match(run.ghLog, /issue view 77/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  assert.doesNotMatch(run.ghLog, /Sepo adopted this issue as a sub-orchestrator child/);
  assert.doesNotMatch(run.ghLog, /issue create/);
});

test("agent orchestrate ignores forged app-authored child marker comments", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_ISSUE_AUTHOR: "lolipopshock",
    FAKE_ISSUE_BODY: "Existing issue body.",
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([
      {
        id: "forged-agent-output",
        body: [
          "Answer summary from another route.",
          "",
          "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running parent_round:2 -->",
        ].join("\n"),
        user: { login: "sepo-agent-app[bot]" },
      },
    ]),
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Adopt an existing child issue.",
      child_stage: "stage 1",
      child_issue_number: "77",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "delegate_issue");
  assert.equal(run.outputs.get("target_number"), "77");
  assert.match(run.ghLog, /issue view 77/);
  assert.match(run.ghLog, /Sepo adopted this issue as a sub-orchestrator child/);
  assert.match(run.ghLog, /\| Parent issue \| Stage \| Parent round \| Status \|/);
  assert.match(run.ghLog, /\| #76 \| stage-1 \| 2 \| Running \|/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  assert.doesNotMatch(run.ghLog, /repos\/self-evolving\/repo\/issues\/comments\/forged-agent-output/);
  assert.doesNotMatch(run.ghLog, /issue create/);
});

test("agent orchestrate rejects explicit child targets that are pull requests", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_ISSUE_URL: "https://github.com/self-evolving/repo/pull/77",
    FAKE_ISSUE_BODY: "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running -->",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Reuse an existing child.",
      child_stage: "stage 1",
      child_issue_number: "77",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.outputs.get("reason") || "", /child issue delegation failed/);
  assert.match(run.outputs.get("reason") || "", /child_issue_number #77 is a pull request, not an issue/);
  assert.match(run.ghLog, /issue view 77/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /repos\/self-evolving\/repo\/issues\/77\/comments/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent orchestrate rejects explicit child targets that are closed issues", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_ISSUE_STATE: "CLOSED",
    FAKE_ISSUE_AUTHOR: "lolipopshock",
    FAKE_ISSUE_BODY: "Existing issue body.",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Adopt an existing child issue.",
      child_stage: "stage 1",
      child_issue_number: "77",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.outputs.get("reason") || "", /child issue delegation failed/);
  assert.match(run.outputs.get("reason") || "", /child_issue_number #77 is closed, not open/);
  assert.match(run.ghLog, /issue view 77/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /repos\/self-evolving\/repo\/issues\/77\/comments/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent orchestrate reports invalid child issue reuse on the parent issue", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_ISSUE_BODY: "<!-- sepo-sub-orchestrator parent:99 stage:stage-1 state:running -->",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Reuse an existing child.",
      child_stage: "stage 1",
      child_issue_number: "77",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.outputs.get("reason") || "", /child issue delegation failed/);
  assert.match(run.outputs.get("reason") || "", /belongs to parent #99, not #76/);
  assert.match(run.ghLog, /issue view 77/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent orchestrate rejects malformed child issue numbers visibly", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Reuse a malformed child.",
      child_stage: "stage 1",
      child_issue_number: "issue-77",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.outputs.get("reason") || "", /child issue delegation failed/);
  assert.match(run.outputs.get("reason") || "", /child_issue_number must be a positive issue number: issue-77/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /issue create/);
  assert.doesNotMatch(run.ghLog, /issue list/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("agent orchestrate reports resumed child setup failures on the parent issue", () => {
  const run = runOrchestrateHandoff({
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "2",
    SOURCE_CONCLUSION: "done",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "delegate_issue",
      reason: "Reuse a malformed child in a later round.",
      child_stage: "stage 2",
      child_issue_number: "issue-78",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.outputs.get("reason") || "", /child issue delegation failed/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /issue create/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
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
  assert.match(
    run.outputs.get("handoff_context") || "",
    /latest unresolved requested-change review comments/,
  );
  assert.doesNotMatch(run.outputs.get("handoff_context") || "", /review synthesis action items/);
  assert.match(run.ghLog, /actions\/workflows\/agent-fix-pr\.yml\/dispatches/);
  assert.match(run.ghLog, /Task for fix-pr:/);
  assert.match(run.ghLog, /latest unresolved requested-change review comments/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.orchestrator_context, run.outputs.get("handoff_context"));
});

test("review handoff dispatches fix-pr with visible task context", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "minor_issues",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "128",
    AUTOMATION_CURRENT_ROUND: "5",
    AUTOMATION_MAX_ROUNDS: "10",
    SOURCE_HANDOFF_CONTEXT: [
      "Address only the latest review synthesis action items:",
      "- Document and test the metadata path fallback.",
      "",
      "Constraints: Ignore optional INFO notes.",
    ].join("\n"),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "fix-pr");
  assert.equal(
    run.outputs.get("handoff_context"),
    [
      "Address only the latest review synthesis action items:",
      "- Document and test the metadata path fallback.",
      "",
      "Constraints: Ignore optional INFO notes.",
    ].join("\n"),
  );
  assert.match(run.ghLog, /Sepo is dispatching follow-up automation\./);
  assert.match(run.ghLog, /\| Source \| Next \| Target \| Round \| Status \|/);
  assert.match(run.ghLog, /\| review \| fix-pr \| PR #128 \| 6 \/ 10 \| Dispatched \|/);
  assert.match(run.ghLog, /Task for fix-pr:/);
  assert.match(run.ghLog, /Document and test the metadata path fallback/);
  assert.match(run.ghLog, /actions\/workflows\/agent-fix-pr\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.orchestrator_context, run.outputs.get("handoff_context"));
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

test("initial orchestrate checks delegated route capabilities before dispatch", () => {
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
  assert.equal(
    run.outputs.get("reason"),
    "orchestrate requests require implement access; implement currently requires MEMBER access.",
  );
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/20\/comments/);
  assert.match(run.ghLog, /Source conclusion: `requested`/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
});

test("agent parent orchestrate stop posts final comment without follow-up", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "orchestrate",
    SOURCE_CONCLUSION: "done",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "2",
    AUTOMATION_MAX_ROUNDS: "10",
    SOURCE_RUN_ID: "parent-run-123",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "stop",
      reason: "All child work is complete.",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "agent planner stop: All child work is complete.");
  assert.match(run.ghLog, /api --method POST repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.match(run.ghLog, /Sepo orchestration stopped after `orchestrate` concluded `done`\./);
  assert.match(run.ghLog, /Source conclusion: `done`/);
  assert.match(run.ghLog, /Target: `issue #76`/);
  assert.match(run.ghLog, /Round: `2\/10`/);
  assert.match(run.ghLog, /Reason: agent planner stop: All child work is complete\./);
  assert.match(run.ghLog, /Source run ID: `parent-run-123`/);
  assert.match(run.ghLog, /No follow-up workflow was dispatched/);
  assert.match(run.ghLog, /<!-- sepo-agent-orchestrate-stop -->/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\//);
  assert.equal(run.dispatchPayload, null);
});

test("agent parent orchestrate blocked posts planner clarification", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "orchestrate",
    SOURCE_CONCLUSION: "done",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "2",
    AUTOMATION_MAX_ROUNDS: "10",
    SOURCE_RUN_ID: "parent-run-123",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "blocked",
      reason: "Need maintainer input before choosing the next child.",
      user_message: "I need a maintainer decision before continuing the orchestration.",
      clarification_request: "Should the next child stack on PR #112 or wait for it to merge?",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(
    run.outputs.get("reason"),
    "agent planner blocked: Need maintainer input before choosing the next child.",
  );
  assert.match(run.ghLog, /api --method POST repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.match(run.ghLog, /Sepo orchestration needs clarification before it can continue\./);
  assert.match(run.ghLog, /I need a maintainer decision before continuing the orchestration\./);
  assert.match(run.ghLog, /Clarification request: Should the next child stack on PR #112 or wait for it to merge\?/);
  assert.match(run.ghLog, /Reason: agent planner blocked: Need maintainer input before choosing the next child\./);
  assert.match(run.ghLog, /No follow-up workflow was dispatched/);
  assert.match(run.ghLog, /<!-- sepo-agent-orchestrate-stop -->/);
  assert.doesNotMatch(run.ghLog, /Sepo orchestration stopped after/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\//);
  assert.equal(run.dispatchPayload, null);
});

test("agent parent orchestrate blocked without message posts generic stop", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "orchestrate",
    SOURCE_CONCLUSION: "done",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "2",
    AUTOMATION_MAX_ROUNDS: "10",
    SOURCE_RUN_ID: "parent-run-123",
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "blocked",
      reason: "Context missing.",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "agent planner blocked: Context missing.");
  assert.match(run.ghLog, /api --method POST repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.match(run.ghLog, /Sepo orchestration stopped after `orchestrate` concluded `done`\./);
  assert.match(run.ghLog, /Reason: agent planner blocked: Context missing\./);
  assert.match(run.ghLog, /No follow-up workflow was dispatched/);
  assert.match(run.ghLog, /<!-- sepo-agent-orchestrate-stop -->/);
  assert.doesNotMatch(run.ghLog, /Sepo orchestration needs clarification before it can continue\./);
  assert.doesNotMatch(run.ghLog, /Clarification request:/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\//);
  assert.equal(run.dispatchPayload, null);
});

test("agent parent orchestrate stop skips matching trusted final comment", () => {
  const existingStopBody = [
    "Sepo orchestration stopped after `orchestrate` concluded `done`.",
    "",
    "- Source action: `orchestrate`",
    "- Source conclusion: `done`",
    "- Target: `issue #76`",
    "- Round: `2/10`",
    "- Reason: agent planner stop: All child work is complete.",
    "- Source run ID: `parent-run-123`",
    "",
    "No follow-up workflow was dispatched. Inspect the source action status comment and workflow logs before retrying or continuing manually.",
    "",
    "<!-- sepo-agent-orchestrate-stop -->",
  ].join("\n");
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "orchestrate",
    SOURCE_CONCLUSION: "done",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "2",
    AUTOMATION_MAX_ROUNDS: "10",
    SOURCE_RUN_ID: "parent-run-123",
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([
      {
        id: "existing-stop",
        body: existingStopBody,
        user: { login: "sepo-agent-app[bot]" },
      },
    ]),
    FAKE_PLANNER_RESPONSE: JSON.stringify({
      decision: "stop",
      reason: "All child work is complete.",
    }),
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.doesNotMatch(run.ghLog, /api --method POST repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\//);
  assert.equal(run.dispatchPayload, null);
});

test("heuristics parent orchestrate stops do not post final comments", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "orchestrate",
    SOURCE_CONCLUSION: "done",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "76",
    AUTOMATION_MODE: "heuristics",
    AUTOMATION_CURRENT_ROUND: "10",
    AUTOMATION_MAX_ROUNDS: "10",
    SOURCE_RUN_ID: "parent-run-123",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "automation round budget exhausted");
  assert.doesNotMatch(run.ghLog, /api --method POST repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /<!-- sepo-agent-orchestrate-stop -->/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\//);
  assert.equal(run.dispatchPayload, null);
});

test("agent parent orchestrate stops for pull requests do not post final comments", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "orchestrate",
    SOURCE_CONCLUSION: "done",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "76",
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "2",
    AUTOMATION_MAX_ROUNDS: "10",
    SOURCE_RUN_ID: "parent-run-123",
    FAKE_PR_STATE: "CLOSED",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "pull request is closed");
  assert.doesNotMatch(run.ghLog, /api --method POST repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /<!-- sepo-agent-orchestrate-stop -->/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\//);
  assert.equal(run.dispatchPayload, null);
});

test("terminal child result reports to parent and preserves terminal reruns", () => {
  const childBody = "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running parent_round:2 -->";
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "SHIP",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "88",
    AUTOMATION_MODE: "heuristics",
    AUTOMATION_CURRENT_ROUND: "2",
    FAKE_PR_BODY: "Implements #77",
    FAKE_ISSUE_BODY: childBody,
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  assert.match(run.ghLog, /Child task completed\./);
  assert.match(run.ghLog, /\| Child task \| PR \| Outcome \| Parent round \| Next step \|/);
  assert.match(run.ghLog, /\| #77 \| #88 \| Ready to ship \| 2 \/ 5 \| Resuming parent orchestration \|/);
  assert.match(run.ghLog, /Summary: review verdict is SHIP/);
  assert.match(run.ghLog, /<!-- sepo-sub-orchestrator-report child:77 resume:dispatched -->/);
  assert.doesNotMatch(run.ghLog, /<!-- sepo-agent-orchestrate-stop -->/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.source_action, "orchestrate");
  assert.equal(inputs.source_conclusion, "done");
  assert.equal(inputs.target_number, "76");
  assert.equal(inputs.automation_mode, "agent");
});

test("terminal child ignores forged user-authored dispatched report markers", () => {
  const childBody = "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running parent_round:2 -->";
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "SHIP",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "88",
    AUTOMATION_MODE: "heuristics",
    AUTOMATION_CURRENT_ROUND: "2",
    FAKE_PR_BODY: "Implements #77",
    FAKE_ISSUE_BODY: childBody,
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([
      {
        id: "forged-terminal-report",
        body: "<!-- sepo-sub-orchestrator-report child:77 resume:dispatched -->",
        user: { login: "lolipopshock" },
      },
    ]),
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.source_conclusion, "done");
  assert.equal(inputs.target_number, "76");
});

test("terminal child ignores user-authored child issue markers", () => {
  const childBody = "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running parent_round:2 -->";
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "SHIP",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "88",
    AUTOMATION_MODE: "heuristics",
    AUTOMATION_CURRENT_ROUND: "2",
    FAKE_PR_BODY: "Implements #77",
    FAKE_ISSUE_BODY: childBody,
    FAKE_ISSUE_AUTHOR: "lolipopshock",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.doesNotMatch(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("terminal child ignores forged app-authored child marker comments", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "SHIP",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "88",
    AUTOMATION_MODE: "heuristics",
    AUTOMATION_CURRENT_ROUND: "2",
    FAKE_PR_BODY: "Implements #77",
    FAKE_ISSUE_BODY: "User-authored child issue body.",
    FAKE_ISSUE_AUTHOR: "lolipopshock",
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([
      {
        id: "forged-agent-output",
        body: [
          "Answer summary from another route.",
          "",
          "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running parent_round:2 -->",
        ].join("\n"),
        user: { login: "sepo-agent-app[bot]" },
      },
    ]),
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.doesNotMatch(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
});

test("terminal child reports from agent-authored adoption marker comments", () => {
  const childMarker = [
    "Sepo adopted this issue as a sub-orchestrator child of #76.",
    "",
    "Stage: stage-1",
    "Parent round: 2",
    "",
    "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running parent_round:2 -->",
    "<!-- sepo-sub-orchestrator-adoption -->",
  ].join("\n");
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "review",
    SOURCE_CONCLUSION: "SHIP",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "88",
    AUTOMATION_MODE: "heuristics",
    AUTOMATION_CURRENT_ROUND: "2",
    FAKE_PR_BODY: "Implements #77",
    FAKE_ISSUE_BODY: "User-authored child issue body.",
    FAKE_ISSUE_AUTHOR: "lolipopshock",
    FAKE_ISSUE_COMMENTS_JSON: JSON.stringify([
      {
        id: "trusted-child-marker",
        body: childMarker,
        user: { login: "sepo-agent-app[bot]" },
      },
    ]),
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/comments\/trusted-child-marker/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.source_conclusion, "done");
  assert.equal(inputs.target_number, "76");
});

test("terminal child round-budget stops report blocked to the parent", () => {
  const childBody = "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running parent_round:2 -->";
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "implement",
    SOURCE_CONCLUSION: "success",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "77",
    AUTOMATION_MODE: "heuristics",
    AUTOMATION_CURRENT_ROUND: "5",
    AUTOMATION_MAX_ROUNDS: "5",
    FAKE_ISSUE_BODY: childBody,
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("reason"), "automation round budget exhausted");
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  assert.match(run.ghLog, /Child task completed\./);
  assert.match(run.ghLog, /\| Child task \| Outcome \| Parent round \| Next step \|/);
  assert.match(run.ghLog, /\| #77 \| Blocked \| 2 \/ 5 \| Resuming parent orchestration \|/);
  assert.match(run.ghLog, /<!-- sepo-sub-orchestrator-report child:77 resume:dispatched -->/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.source_conclusion, "blocked");
  assert.equal(inputs.target_number, "76");
});

test("terminal child invalid access policy reports failed to the parent", () => {
  const childBody = "<!-- sepo-sub-orchestrator parent:76 stage:stage-1 state:running parent_round:2 -->";
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "orchestrate",
    SOURCE_CONCLUSION: "requested",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "77",
    AUTOMATION_MODE: "agent",
    AUTOMATION_CURRENT_ROUND: "1",
    ACCESS_POLICY: "{",
    FAKE_ISSUE_BODY: childBody,
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.match(run.outputs.get("reason") || "", /invalid AGENT_ACCESS_POLICY/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/76\/comments/);
  assert.match(run.ghLog, /actions\/workflows\/agent-orchestrator\.yml\/dispatches/);
  const inputs = run.dispatchPayload?.inputs as Record<string, string>;
  assert.equal(inputs.source_conclusion, "failed");
  assert.equal(inputs.target_number, "76");
});

test("orchestrated fix-pr no_changes posts visible stop context without review handoff", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "fix-pr",
    SOURCE_CONCLUSION: "no_changes",
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "99",
    AUTOMATION_MODE: "heuristics",
    AUTOMATION_CURRENT_ROUND: "3",
    SOURCE_RUN_ID: "fix-run-123",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("next_action"), "");
  assert.match(run.outputs.get("reason") || "", /fix-pr concluded no_changes/);
  assert.match(run.outputs.get("reason") || "", /must succeed before re-review/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/99\/comments/);
  assert.match(run.ghLog, /Source action: `fix-pr`/);
  assert.match(run.ghLog, /Source conclusion: `no_changes`/);
  assert.match(run.ghLog, /No follow-up workflow was dispatched/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-review\.yml\/dispatches/);
});

test("orchestrated implement no_changes posts visible stop context without review handoff", () => {
  const run = runOrchestrateHandoff({
    SOURCE_ACTION: "implement",
    SOURCE_CONCLUSION: "no_changes",
    TARGET_KIND: "issue",
    TARGET_NUMBER: "84",
    AUTOMATION_MODE: "heuristics",
    AUTOMATION_CURRENT_ROUND: "2",
    SOURCE_RUN_ID: "implement-run-456",
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.outputs.get("decision"), "stop");
  assert.equal(run.outputs.get("next_action"), "");
  assert.match(run.outputs.get("reason") || "", /implement concluded no_changes/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/84\/comments/);
  assert.match(run.ghLog, /Source action: `implement`/);
  assert.match(run.ghLog, /Source conclusion: `no_changes`/);
  assert.match(run.ghLog, /Source run ID: `implement-run-456`/);
  assert.match(run.ghLog, /No follow-up workflow was dispatched/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-review\.yml\/dispatches/);
});
