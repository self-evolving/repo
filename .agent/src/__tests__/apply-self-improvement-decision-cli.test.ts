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

function writeFakeGh(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
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
if [ "\${1-}" = "api" ] && [[ "\${2-}" = repos/*/pulls/17 ]]; then
  printf 'open\n'
  exit 0
fi
if [ "\${1-}" = "api" ] && [[ "\${2-}" = repos/*/issues/18 ]]; then
  printf '{"state":"open"}\n'
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

test("apply self-improvement decision creates new issue and dispatches orchestrator", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "self-improvement-decision-"));
  try {
    const fakeGh = join(tempDir, "gh");
    const responseFile = join(tempDir, "response.md");
    const outputFile = join(tempDir, "github-output");
    const issueBody = join(tempDir, "issue-body.md");
    const commentArgs = join(tempDir, "comment-args.txt");
    const dispatchPayload = join(tempDir, "dispatch.json");
    writeFakeGh(fakeGh);
    writeFileSync(outputFile, "", "utf8");
    writeFileSync(responseFile, JSON.stringify({
      decision: "new_issue",
      reason: "No existing target is better.",
      issue_title: "code-quality: Add self-improvement tests",
      issue_body: "## Proposal\n\nAdd tests for the route.",
    }), "utf8");

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
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_OUTPUT: outputFile,
        GITHUB_REPOSITORY: "co-evolving/repo",
        GITHUB_RUN_ID: "12345",
        GITHUB_SERVER_URL: "https://github.com",
        RESPONSE_FILE: responseFile,
        RUNNER_TEMP: tempDir,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const body = readFileSync(issueBody, "utf8");
    assert.match(body, /^# code-quality: Add self-improvement tests/m);
    assert.match(body, /sepo-agent-self-improvement-proposal/);
    assert.match(body, /sepo-agent-self-improvement-decision/);
    assert.match(body, /Source run: https:\/\/github.com\/co-evolving\/repo\/actions\/runs\/12345/);

    const dispatch = JSON.parse(readFileSync(dispatchPayload, "utf8"));
    assert.equal(dispatch.ref, "main");
    assert.equal(dispatch.inputs.target_kind, "issue");
    assert.equal(dispatch.inputs.target_number, "88");
    assert.equal(dispatch.inputs.source_action, "orchestrate");
    assert.equal(dispatch.inputs.source_conclusion, "requested");

    const outputs = parseGithubOutput(outputFile);
    assert.equal(outputs.get("decision"), "new_issue");
    assert.equal(outputs.get("target_kind"), "issue");
    assert.equal(outputs.get("target_number"), "88");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("apply self-improvement decision comments on existing issue and dispatches it", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "self-improvement-decision-"));
  try {
    const fakeGh = join(tempDir, "gh");
    const responseFile = join(tempDir, "response.md");
    const outputFile = join(tempDir, "github-output");
    const issueBody = join(tempDir, "issue-body.md");
    const commentArgs = join(tempDir, "comment-args.txt");
    const dispatchPayload = join(tempDir, "dispatch.json");
    writeFakeGh(fakeGh);
    writeFileSync(outputFile, "", "utf8");
    writeFileSync(responseFile, JSON.stringify({
      decision: "continue_issue",
      target_number: 18,
      reason: "The existing issue is the best recovery target.",
      comment: "Continue this issue instead of opening another proposal.",
    }), "utf8");

    const result = spawnSync("node", [".agent/dist/cli/apply-self-improvement-decision.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        AUTHOR_ASSOCIATION: "MEMBER",
        DEFAULT_BRANCH: "main",
        FAKE_COMMENT_ARGS: commentArgs,
        FAKE_DISPATCH_PAYLOAD: dispatchPayload,
        FAKE_ISSUE_BODY: issueBody,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_OUTPUT: outputFile,
        GITHUB_REPOSITORY: "co-evolving/repo",
        GITHUB_RUN_ID: "12347",
        RESPONSE_FILE: responseFile,
        RUNNER_TEMP: tempDir,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const comment = readFileSync(commentArgs, "utf8");
    assert.match(comment, /^issue comment 18 --body Scheduled self-improvement selected this issue #18/);
    assert.match(comment, /\n\n/);
    const dispatch = JSON.parse(readFileSync(dispatchPayload, "utf8"));
    assert.equal(dispatch.inputs.target_kind, "issue");
    assert.equal(dispatch.inputs.target_number, "18");
    assert.equal(dispatch.inputs.author_association, "MEMBER");

    const outputs = parseGithubOutput(outputFile);
    assert.equal(outputs.get("decision"), "continue_issue");
    assert.equal(outputs.get("target_kind"), "issue");
    assert.equal(outputs.get("target_number"), "18");
    assert.equal(outputs.get("comment_posted"), "true");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("apply self-improvement decision comments on existing PR and dispatches it", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "self-improvement-decision-"));
  try {
    const fakeGh = join(tempDir, "gh");
    const responseFile = join(tempDir, "response.md");
    const outputFile = join(tempDir, "github-output");
    const issueBody = join(tempDir, "issue-body.md");
    const commentArgs = join(tempDir, "comment-args.txt");
    const dispatchPayload = join(tempDir, "dispatch.json");
    writeFakeGh(fakeGh);
    writeFileSync(outputFile, "", "utf8");
    writeFileSync(responseFile, JSON.stringify({
      decision: "continue_pr",
      target_number: 17,
      reason: "The open PR is the best recovery target.",
      comment: "Continue this PR instead of opening another proposal.",
    }), "utf8");

    const result = spawnSync("node", [".agent/dist/cli/apply-self-improvement-decision.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        AUTHOR_ASSOCIATION: "OWNER",
        DEFAULT_BRANCH: "main",
        FAKE_COMMENT_ARGS: commentArgs,
        FAKE_DISPATCH_PAYLOAD: dispatchPayload,
        FAKE_ISSUE_BODY: issueBody,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_OUTPUT: outputFile,
        GITHUB_REPOSITORY: "co-evolving/repo",
        GITHUB_RUN_ID: "12346",
        RESPONSE_FILE: responseFile,
        RUNNER_TEMP: tempDir,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(commentArgs, "utf8"), /^pr comment 17 --body Scheduled self-improvement selected this pull request #17/);
    const dispatch = JSON.parse(readFileSync(dispatchPayload, "utf8"));
    assert.equal(dispatch.inputs.target_kind, "pull_request");
    assert.equal(dispatch.inputs.target_number, "17");
    assert.equal(dispatch.inputs.author_association, "OWNER");

    const outputs = parseGithubOutput(outputFile);
    assert.equal(outputs.get("decision"), "continue_pr");
    assert.equal(outputs.get("target_kind"), "pull_request");
    assert.equal(outputs.get("target_number"), "17");
    assert.equal(outputs.get("comment_posted"), "true");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
