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
  issueBody: string;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-orchestrate-handoff-"));
  try {
    const fakeGh = join(tempDir, "gh");
    const outputPath = join(tempDir, "github-output.txt");
    const ghLogPath = join(tempDir, "gh.log");
    const dispatchPayloadPath = join(tempDir, "dispatch.json");
    const issueBodyPath = join(tempDir, "issue-body.md");

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

if [ "\${1-}" = "issue" ] && [ "\${2-}" = "create" ]; then
  body_file=""
  while [ "$#" -gt 0 ]; do
    if [ "\${1-}" = "--body-file" ]; then
      shift
      body_file="\${1-}"
    fi
    shift || true
  done
  if [ -n "$body_file" ]; then
    cat "$body_file" > "$FAKE_ISSUE_BODY"
  fi
  printf 'https://github.com/self-evolving/repo/issues/%s\\n' "\${FAKE_CREATED_ISSUE_NUMBER-88}"
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
        FAKE_ISSUE_BODY: issueBodyPath,
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
    let issueBody = "";
    if (existsSync(issueBodyPath)) {
      try {
        issueBody = readFileSync(issueBodyPath, "utf8");
      } catch {
        issueBody = "";
      }
    }

    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      outputs: parseGithubOutput(outputPath),
      ghLog,
      issueBody,
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
  assert.equal(
    run.outputs.get("reason"),
    "pull request is closed; closed PR follow-up needs a concrete code-change request",
  );
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/21\/comments/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
});

test("manual orchestrate creates an issue for closed PR code follow-ups", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "39",
    FAKE_PR_STATE: "MERGED",
    REQUEST_TEXT: "@sepo-agent /orchestrate can you do a quick patch for that fix?",
    SOURCE_COMMENT_URL: "https://github.com/self-evolving/repo/pull/39#issuecomment-123",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "implement");
  assert.equal(run.outputs.get("target_number"), "88");
  assert.equal(
    run.outputs.get("reason"),
    "manual orchestrate start on merged PR; created follow-up issue #88 and dispatching implement",
  );
  assert.match(run.ghLog, /issue create/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/39\/comments/);
  assert.match(run.ghLog, /repos\/self-evolving\/repo\/issues\/88\/comments/);
  assert.match(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
  assert.match(run.issueBody, /can you do a quick patch for that fix\?/);
  assert.match(run.issueBody, /https:\/\/github\.com\/self-evolving\/repo\/pull\/39/);
  assert.match(run.issueBody, /https:\/\/github\.com\/self-evolving\/repo\/pull\/39#issuecomment-123/);
});

test("closed PR follow-ups validate implement access before creating an issue", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "pull_request",
    TARGET_NUMBER: "39",
    FAKE_PR_STATE: "MERGED",
    REQUEST_TEXT: "@sepo-agent /orchestrate can you do a quick patch for that fix?",
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
  assert.doesNotMatch(run.ghLog, /issue create/);
  assert.doesNotMatch(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
});

test("manual orchestrate dispatches implement for issue targets", () => {
  const run = runOrchestrateHandoff({
    TARGET_KIND: "issue",
    TARGET_NUMBER: "20",
  });

  assert.equal(run.status, 0);
  assert.equal(run.outputs.get("decision"), "dispatch");
  assert.equal(run.outputs.get("next_action"), "implement");
  assert.match(run.ghLog, /actions\/workflows\/agent-implement\.yml\/dispatches/);
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
