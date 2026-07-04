import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

interface DecisionFixturePaths {
  commentArgs: string;
  dispatchPayload: string;
  issueBody: string;
  outputFile: string;
  responseFile: string;
  tempDir: string;
}

function parseGithubOutput(path: string): Map<string, string> {
  const raw = readFileSync(path, "utf8");
  const outputs = new Map<string, string>();
  const blocks = raw.matchAll(/^([^<\n]+)<<([^\n]+)\n([\s\S]*?)\n\2$/gm);
  for (const [, name, , value] of blocks) {
    outputs.set(name, value);
  }
  return outputs;
}

function writeFakeGh(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "api" ] && [ "\${2-}" = "--method" ] && [ "\${3-}" = "GET" ] && [[ "\${4-}" = repos/*/issues ]]; then
  if [ "\${FAKE_EXISTING_PROPOSAL_ISSUE:-}" = "true" ]; then
    author="\${FAKE_EXISTING_PROPOSAL_ISSUE_AUTHOR:-app/sepo-agent-app}"
    body='# Existing proposal\\n\\n<!-- sepo-agent-self-improvement-proposal -->\\n<!-- sepo-agent-self-improvement-decision -->\\n<!-- sepo-agent-self-improvement-run:12345 -->'
    printf '[{"number":89,"state":"open","html_url":"https://github.com/co-evolving/repo/issues/89","user":{"login":"%s"},"body":"%s"}]\n' "$author" "$body"
  else
    printf '[]\n'
  fi
  exit 0
fi
if [ "\${1-}" = "api" ] && [ "\${2-}" = "graphql" ]; then
  printf '{"data":{"viewer":{"login":"sepo-agent-app[bot]"}}}\n'
  exit 0
fi
if [ "\${1-}" = "api" ] && [ "\${2-}" = "--paginate" ] && [ "\${3-}" = "--slurp" ] && [[ "\${4-}" = repos/*/issues/*/comments ]]; then
  if [ "\${FAKE_EXISTING_CONTINUATION_COMMENT:-}" = "true" ]; then
    author="\${FAKE_EXISTING_CONTINUATION_COMMENT_AUTHOR:-app/sepo-agent-app}"
    body='Existing continuation trace.\\n\\n<!-- sepo-agent-self-improvement-decision -->\\n<!-- sepo-agent-self-improvement-run:12345 -->'
    printf '[[{"body":"%s","user":{"login":"%s"}}]]\n' "$body" "$author"
  else
    printf '[]\n'
  fi
  exit 0
fi
if [ "\${1-}" = "api" ] && [[ "\${2-}" = repos/*/collaborators/*/permission ]]; then
  printf '%s\n' "\${FAKE_TARGET_AUTHOR_PERMISSION:-none}"
  exit 0
fi
if [ "\${1-}" = "issue" ] && [ "\${2-}" = "create" ]; then
  body_file=""
  while [ "$#" -gt 0 ]; do
    if [ "\${1-}" = "--body-file" ]; then
      body_file="\${2-}"
      break
    fi
    shift
  done
  cp "$body_file" "$FAKE_ISSUE_BODY"
  printf 'https://github.com/co-evolving/repo/issues/88\n'
  exit 0
fi
if [ "\${1-}" = "issue" ] && [ "\${2-}" = "comment" ]; then
  printf '%s\n' "$*" > "$FAKE_COMMENT_ARGS"
  exit 0
fi
if [ "\${1-}" = "pr" ] && [ "\${2-}" = "comment" ]; then
  printf '%s\n' "$*" > "$FAKE_COMMENT_ARGS"
  exit 0
fi
if [ "\${1-}" = "api" ] && [[ "\${2-}" = repos/*/pulls/* ]]; then
  number="\${2##*/pulls/}"
  missing_var="FAKE_PR_\${number}_MISSING"
  if [ "\${!missing_var:-}" = "true" ]; then
    printf 'missing pull request %s\n' "$number" >&2
    exit 1
  fi
  state_var="FAKE_PR_\${number}_STATE"
  author_var="FAKE_PR_\${number}_AUTHOR"
  printf '{"state":"%s","user":{"login":"%s"}}\n' "\${!state_var:-open}" "\${!author_var:-app/sepo-agent-app}"
  exit 0
fi
if [ "\${1-}" = "api" ] && [[ "\${2-}" = repos/*/issues/* ]]; then
  number="\${2##*/issues/}"
  missing_var="FAKE_ISSUE_\${number}_MISSING"
  if [ "\${!missing_var:-}" = "true" ]; then
    printf 'missing issue %s\n' "$number" >&2
    exit 1
  fi
  state_var="FAKE_ISSUE_\${number}_STATE"
  pull_var="FAKE_ISSUE_\${number}_PULL_REQUEST"
  author_var="FAKE_ISSUE_\${number}_AUTHOR"
  state="\${!state_var:-open}"
  if [ "\${!pull_var:-}" = "true" ]; then
    printf '{"state":"%s","user":{"login":"%s"},"pull_request":{"url":"https://api.github.com/repos/co-evolving/repo/pulls/%s"}}\n' "$state" "\${!author_var:-app/sepo-agent-app}" "$number"
  else
    printf '{"state":"%s","user":{"login":"%s"}}\n' "$state" "\${!author_var:-app/sepo-agent-app}"
  fi
  exit 0
fi
if [ "\${1-}" = "api" ] && [ "\${2-}" = "-X" ] && [ "\${3-}" = "POST" ]; then
  cat > "$FAKE_DISPATCH_PAYLOAD"
  exit 0
fi
printf 'unexpected gh args: %s\n' "$*" >&2
exit 1
`,
    { encoding: "utf8", mode: 0o755 },
  );
}

function runDecisionFixture(
  decision: Record<string, unknown>,
  env: Record<string, string> = {},
): { result: SpawnSyncReturns<string>; paths: DecisionFixturePaths } {
  const tempDir = mkdtempSync(join(tmpdir(), "self-improvement-decision-"));
  const fakeGh = join(tempDir, "gh");
  const responseFile = join(tempDir, "response.md");
  const outputFile = join(tempDir, "github-output");
  const issueBody = join(tempDir, "issue-body.md");
  const commentArgs = join(tempDir, "comment-args.txt");
  const dispatchPayload = join(tempDir, "dispatch.json");
  writeFakeGh(fakeGh);
  writeFileSync(outputFile, "", "utf8");
  writeFileSync(responseFile, JSON.stringify(decision), "utf8");

  const result = spawnSync("node", [".agent/dist/cli/apply-self-improvement-decision.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ACCESS_POLICY: "",
      AUTHOR_ASSOCIATION: "OWNER",
      AUTOMATION_MAX_ROUNDS: "12",
      AUTOMATION_MODE: "agent",
      DEFAULT_BRANCH: "main",
      FAKE_COMMENT_ARGS: commentArgs,
      FAKE_DISPATCH_PAYLOAD: dispatchPayload,
      FAKE_ISSUE_BODY: issueBody,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "co-evolving/repo",
      GITHUB_RUN_ID: "12345",
      GITHUB_SERVER_URL: "https://github.com",
      RESPONSE_FILE: responseFile,
      RUNNER_TEMP: tempDir,
      ...env,
    },
    encoding: "utf8",
  }) as SpawnSyncReturns<string>;

  return {
    result,
    paths: {
      commentArgs,
      dispatchPayload,
      issueBody,
      outputFile,
      responseFile,
      tempDir,
    },
  };
}

function cleanup(paths: DecisionFixturePaths): void {
  rmSync(paths.tempDir, { recursive: true, force: true });
}

function assertNoCommentOrDispatch(paths: DecisionFixturePaths): void {
  assert.equal(existsSync(paths.commentArgs), false, "comment should not be posted");
  assert.equal(existsSync(paths.dispatchPayload), false, "orchestrator should not be dispatched");
}

function assertNoCreateCommentOrDispatch(paths: DecisionFixturePaths): void {
  assert.equal(existsSync(paths.issueBody), false, "issue should not be created");
  assertNoCommentOrDispatch(paths);
}

test("apply self-improvement decision creates new issue and dispatches orchestrator", () => {
  const { result, paths } = runDecisionFixture({
    decision: "new_issue",
    reason: "No existing target is better.",
    issue_title: "code-quality: Add self-improvement tests",
    issue_body: "## Proposal\n\nAdd tests for the route.",
  }, { GITHUB_EVENT_NAME: "schedule" });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const body = readFileSync(paths.issueBody, "utf8");
    assert.match(body, /^# code-quality: Add self-improvement tests/m);
    assert.match(body, /sepo-agent-self-improvement-proposal/);
    assert.match(body, /sepo-agent-self-improvement-decision/);
    assert.match(body, /Source run: https:\/\/github.com\/co-evolving\/repo\/actions\/runs\/12345/);

    const dispatch = JSON.parse(readFileSync(paths.dispatchPayload, "utf8"));
    assert.equal(dispatch.ref, "main");
    assert.equal(dispatch.inputs.target_kind, "issue");
    assert.equal(dispatch.inputs.target_number, "88");
    assert.equal(dispatch.inputs.source_action, "orchestrate");
    assert.equal(dispatch.inputs.source_conclusion, "requested");

    const outputs = parseGithubOutput(paths.outputFile);
    assert.equal(outputs.get("decision"), "new_issue");
    assert.equal(outputs.get("target_kind"), "issue");
    assert.equal(outputs.get("target_number"), "88");
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision rejects denied manual requester before side effects", () => {
  const deniedManualEnv = {
    ACCESS_POLICY: JSON.stringify({ allowed_associations: ["OWNER"] }),
    AUTHOR_ASSOCIATION: "CONTRIBUTOR",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    REPOSITORY_PRIVATE: "false",
    REQUESTED_BY: "octocat",
  };
  const deniedNewIssue = runDecisionFixture({
    decision: "new_issue",
    reason: "A fresh proposal would be useful.",
    issue_title: "code-quality: Add self-improvement tests",
    issue_body: "## Proposal\n\nAdd tests for the route.",
  }, deniedManualEnv);
  try {
    assert.equal(deniedNewIssue.result.status, 1);
    assert.match(deniedNewIssue.result.stderr, /orchestrate requests require implement access/);
    assertNoCreateCommentOrDispatch(deniedNewIssue.paths);
  } finally {
    cleanup(deniedNewIssue.paths);
  }

  const deniedContinuation = runDecisionFixture({
    decision: "continue_issue",
    target_number: 18,
    reason: "An existing issue would be useful.",
    comment: "Continue this issue.",
  }, deniedManualEnv);
  try {
    assert.equal(deniedContinuation.result.status, 1);
    assert.match(deniedContinuation.result.stderr, /orchestrate requests require implement access/);
    assertNoCreateCommentOrDispatch(deniedContinuation.paths);
  } finally {
    cleanup(deniedContinuation.paths);
  }
});

test("apply self-improvement decision reuses same-run proposal issue", () => {
  const { result, paths } = runDecisionFixture({
    decision: "new_issue",
    reason: "No existing target is better.",
    issue_title: "code-quality: Add self-improvement tests",
    issue_body: "## Proposal\n\nAdd tests for the route.",
  }, { FAKE_EXISTING_PROPOSAL_ISSUE: "true" });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(paths.issueBody), false, "issue should not be created again");
    const dispatch = JSON.parse(readFileSync(paths.dispatchPayload, "utf8"));
    assert.equal(dispatch.inputs.target_kind, "issue");
    assert.equal(dispatch.inputs.target_number, "89");

    const outputs = parseGithubOutput(paths.outputFile);
    assert.equal(outputs.get("decision"), "new_issue");
    assert.equal(outputs.get("target_kind"), "issue");
    assert.equal(outputs.get("target_number"), "89");
    assert.equal(outputs.get("issue_url"), "https://github.com/co-evolving/repo/issues/89");
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision ignores forged proposal markers", () => {
  const { result, paths } = runDecisionFixture({
    decision: "new_issue",
    reason: "No existing target is better.",
    issue_title: "code-quality: Add self-improvement tests",
    issue_body: "## Proposal\n\nAdd tests for the route.",
  }, {
    FAKE_EXISTING_PROPOSAL_ISSUE: "true",
    FAKE_EXISTING_PROPOSAL_ISSUE_AUTHOR: "octocat",
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(paths.issueBody), true, "untrusted marked issue should not be reused");
    const dispatch = JSON.parse(readFileSync(paths.dispatchPayload, "utf8"));
    assert.equal(dispatch.inputs.target_kind, "issue");
    assert.equal(dispatch.inputs.target_number, "88");

    const outputs = parseGithubOutput(paths.outputFile);
    assert.equal(outputs.get("decision"), "new_issue");
    assert.equal(outputs.get("target_kind"), "issue");
    assert.equal(outputs.get("target_number"), "88");
    assert.equal(outputs.get("issue_url"), "https://github.com/co-evolving/repo/issues/88");
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision comments on existing issue and dispatches it", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_issue",
    target_number: 18,
    reason: "The existing issue is the best recovery target.",
    comment: "Continue this issue instead of opening another proposal.",
  }, { AUTHOR_ASSOCIATION: "MEMBER" });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const comment = readFileSync(paths.commentArgs, "utf8");
    assert.match(comment, /^issue comment 18 --body Scheduled self-improvement selected this issue #18/);
    assert.match(comment, /\n\n/);
    const dispatch = JSON.parse(readFileSync(paths.dispatchPayload, "utf8"));
    assert.equal(dispatch.inputs.target_kind, "issue");
    assert.equal(dispatch.inputs.target_number, "18");
    assert.equal(dispatch.inputs.author_association, "MEMBER");

    const outputs = parseGithubOutput(paths.outputFile);
    assert.equal(outputs.get("decision"), "continue_issue");
    assert.equal(outputs.get("target_kind"), "issue");
    assert.equal(outputs.get("target_number"), "18");
    assert.equal(outputs.get("comment_posted"), "true");
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision allows trusted continuation target authors", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_issue",
    target_number: 18,
    reason: "The existing issue is the best recovery target.",
    comment: "Continue this issue instead of opening another proposal.",
  }, {
    FAKE_ISSUE_18_AUTHOR: "octocat",
    FAKE_TARGET_AUTHOR_PERMISSION: "write",
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(paths.commentArgs, "utf8"), /^issue comment 18 --body Scheduled self-improvement selected this issue #18/);
    const dispatch = JSON.parse(readFileSync(paths.dispatchPayload, "utf8"));
    assert.equal(dispatch.inputs.target_kind, "issue");
    assert.equal(dispatch.inputs.target_number, "18");
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision rejects untrusted issue targets", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_issue",
    target_number: 18,
    reason: "The existing issue is the best recovery target.",
    comment: "Continue this issue instead of opening another proposal.",
  }, { FAKE_ISSUE_18_AUTHOR: "octocat" });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /continue_issue target #18 must be authored by Sepo or a trusted repository actor/);
    assertNoCommentOrDispatch(paths);
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision skips duplicate same-run continuation comment", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_issue",
    target_number: 18,
    reason: "The existing issue is the best recovery target.",
    comment: "Continue this issue instead of opening another proposal.",
  }, { FAKE_EXISTING_CONTINUATION_COMMENT: "true" });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(paths.commentArgs), false, "comment should not be posted again");
    const dispatch = JSON.parse(readFileSync(paths.dispatchPayload, "utf8"));
    assert.equal(dispatch.inputs.target_kind, "issue");
    assert.equal(dispatch.inputs.target_number, "18");

    const outputs = parseGithubOutput(paths.outputFile);
    assert.equal(outputs.get("decision"), "continue_issue");
    assert.equal(outputs.get("target_kind"), "issue");
    assert.equal(outputs.get("target_number"), "18");
    assert.equal(outputs.get("comment_posted"), "false");
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision ignores forged continuation markers", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_issue",
    target_number: 18,
    reason: "The existing issue is the best recovery target.",
    comment: "Continue this issue instead of opening another proposal.",
  }, {
    FAKE_EXISTING_CONTINUATION_COMMENT: "true",
    FAKE_EXISTING_CONTINUATION_COMMENT_AUTHOR: "octocat",
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(paths.commentArgs, "utf8"), /^issue comment 18 --body Scheduled self-improvement selected this issue #18/);
    const dispatch = JSON.parse(readFileSync(paths.dispatchPayload, "utf8"));
    assert.equal(dispatch.inputs.target_kind, "issue");
    assert.equal(dispatch.inputs.target_number, "18");

    const outputs = parseGithubOutput(paths.outputFile);
    assert.equal(outputs.get("decision"), "continue_issue");
    assert.equal(outputs.get("target_kind"), "issue");
    assert.equal(outputs.get("target_number"), "18");
    assert.equal(outputs.get("comment_posted"), "true");
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision rejects untrusted PR targets", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_pr",
    target_number: 17,
    reason: "The open PR is the best recovery target.",
    comment: "Continue this PR instead of opening another proposal.",
  }, { FAKE_PR_17_AUTHOR: "octocat" });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /continue_pr target #17 must be authored by Sepo or a trusted repository actor/);
    assertNoCommentOrDispatch(paths);
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision comments on existing PR and dispatches it", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_pr",
    target_number: 17,
    reason: "The open PR is the best recovery target.",
    comment: "Continue this PR instead of opening another proposal.",
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(paths.commentArgs, "utf8"), /^pr comment 17 --body Scheduled self-improvement selected this pull request #17/);
    const dispatch = JSON.parse(readFileSync(paths.dispatchPayload, "utf8"));
    assert.equal(dispatch.inputs.target_kind, "pull_request");
    assert.equal(dispatch.inputs.target_number, "17");
    assert.equal(dispatch.inputs.author_association, "OWNER");

    const outputs = parseGithubOutput(paths.outputFile);
    assert.equal(outputs.get("decision"), "continue_pr");
    assert.equal(outputs.get("target_kind"), "pull_request");
    assert.equal(outputs.get("target_number"), "17");
    assert.equal(outputs.get("comment_posted"), "true");
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision rejects closed PR continuation before side effects", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_pr",
    target_number: 19,
    reason: "Try a closed PR.",
  }, { FAKE_PR_19_STATE: "closed" });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /continue_pr target #19 must be an open pull request; got closed/);
    assertNoCommentOrDispatch(paths);
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision rejects missing PR continuation before side effects", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_pr",
    target_number: 22,
    reason: "Try a missing PR.",
  }, { FAKE_PR_22_MISSING: "true" });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /continue_pr target #22 must be an open pull request; got missing/);
    assertNoCommentOrDispatch(paths);
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision rejects missing issue continuation before side effects", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_issue",
    target_number: 23,
    reason: "Try a missing issue.",
  }, { FAKE_ISSUE_23_MISSING: "true" });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /continue_issue target #23 must be an open issue; got missing/);
    assertNoCommentOrDispatch(paths);
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision rejects closed issue continuation before side effects", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_issue",
    target_number: 20,
    reason: "Try a closed issue.",
  }, { FAKE_ISSUE_20_STATE: "closed" });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /continue_issue target #20 must be an open issue; got closed/);
    assertNoCommentOrDispatch(paths);
  } finally {
    cleanup(paths);
  }
});

test("apply self-improvement decision rejects pull request as issue continuation before side effects", () => {
  const { result, paths } = runDecisionFixture({
    decision: "continue_issue",
    target_number: 21,
    reason: "Try a PR through continue_issue.",
  }, { FAKE_ISSUE_21_PULL_REQUEST: "true" });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /continue_issue target #21 is a pull request, not an issue/);
    assertNoCommentOrDispatch(paths);
  } finally {
    cleanup(paths);
  }
});
