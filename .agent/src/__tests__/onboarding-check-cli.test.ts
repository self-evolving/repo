import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");
const expectedSetupIssueBody = `Use this issue to track Sepo setup for this repository.

The latest setup status is maintained in the comment below.
`;

function writeFakeGh(tempDir: string, body: string): void {
  writeFileSync(join(tempDir, "gh"), body, { encoding: "utf8", mode: 0o755 });
}

function runOnboarding(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/onboarding-check.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      RUNNER_TEMP: tempDir,
      ...env,
    },
    encoding: "utf8",
  });
}

function readOnboardingIssueBody(log: string, commandPattern: RegExp): string {
  const match = log.match(commandPattern);
  assert.ok(match, "expected onboarding issue body file in gh log");
  const bodyFile = match[1];
  assert.ok(bodyFile, "expected onboarding issue body file path in gh log");
  return readFileSync(bodyFile, "utf8");
}

test("onboarding-check CLI creates labels, issue, and marker comment", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-onboarding-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "label" ] && [ "$2" = "list" ]; then
  exit 0
fi
if [ "$1" = "label" ] && [ "$2" = "create" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/git/matching-refs/heads/agent/memory ]]; then
  printf 'refs/heads/agent/memory\\n'
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/git/matching-refs/heads/agent/rubrics ]]; then
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '[]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  printf 'https://github.com/self-evolving/repo/issues/77\\n'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/issues/77/comments ]]; then
  printf '[]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runOnboarding(tempDir, {
      AGENT_PROVIDER: "codex",
      AGENT_PROVIDER_REASON: "OPENAI_API_KEY is configured",
      AUTH_MODE: "oidc_broker",
      CLAUDE_CODE_OAUTH_TOKEN_CONFIGURED: "false",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      OPENAI_API_KEY_CONFIGURED: "true",
      RUN_URL: "https://github.com/self-evolving/repo/actions/runs/1",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Sepo onboarding issue is #77/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^label create agent\/answer --color 1f883d --description Ask Sepo to answer/m);
    assert.match(log, /^label create agent\/orchestrate --color fb8c00 --description Ask Sepo to run/m);
    assert.match(log, /^label create agent --color 0e8a16 --description Handled by the agent --repo self-evolving\/repo$/m);
    assert.match(
      log,
      /^label create agent-goal --color 5319e7 --description Marks an issue as a repository-level goal for Sepo planning/m,
    );
    assert.match(log, /^issue create --title Sepo setup check --body-file .+ --repo self-evolving\/repo$/m);
    assert.match(log, /^issue edit 77 --add-label agent --repo self-evolving\/repo$/m);
    assert.match(log, /^issue comment 77 --body <!-- sepo-agent-onboarding-check -->/m);
    const issueBody = readOnboardingIssueBody(
      log,
      /^issue create --title Sepo setup check --body-file ([^ ]*sepo-onboarding-[a-f0-9]+\.md) --repo self-evolving\/repo$/m,
    );
    assert.equal(issueBody, expectedSetupIssueBody);
    assert.doesNotMatch(issueBody, /@sepo-agent/);
    assert.match(log, /## Sepo setup status/);
    assert.match(log, /### Current status/);
    assert.match(log, /GitHub App\/auth: resolved via `oidc_broker`/);
    assert.match(log, /Model credentials: `OPENAI_API_KEY` configured/);
    assert.match(log, /Agent provider: `codex` \(OPENAI_API_KEY is configured\)/);
    assert.match(log, /Memory: initialized \(`agent\/memory`\)/);
    assert.match(log, /Rubrics: not initialized/);
    assert.match(
      log,
      /Optional: run \*\*\[Actions > Agent \/ Rubrics \/ Initialization\]\(https:\/\/github.com\/self-evolving\/repo\/actions\/workflows\/agent-rubrics-initialization\.yml\)\*\*\./,
    );
    assert.match(log, /### Remaining setup/);
    assert.match(
      log,
      /Optional: run \[Agent \/ Rubrics \/ Initialization\]\(https:\/\/github.com\/self-evolving\/repo\/actions\/workflows\/agent-rubrics-initialization\.yml\) to initialize rubrics branch `agent\/rubrics`\./,
    );
    assert.match(log, /### Test Sepo/);
    assert.match(log, /@sepo-agent \/answer Is Sepo configured correctly in this repository\?/);
    assert.match(log, /@sepo-agent \/implement Create a small README update that verifies the agent can open a PR\./);
    assert.match(log, /@sepo-agent \/review/);
    assert.match(log, /Last checked: \[GitHub Actions run\]\(https:\/\/github.com\/self-evolving\/repo\/actions\/runs\/1\)/);
    assert.doesNotMatch(log, /Built-in trigger labels:/);
    assert.doesNotMatch(log, /`agent\/fix-pr` ->/);
    assert.match(log, /agent\/fix-pr/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("onboarding-check CLI updates an existing marker comment", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-onboarding-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "label" ] && [ "$2" = "list" ]; then
  printf '%s\\n' "$4"
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/git/matching-refs/heads/* ]]; then
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '[{"number":5,"title":"Sepo setup check"}]'
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/issues/5/comments ]]; then
  printf '[{"id":123,"body":"<!-- sepo-agent-onboarding-check --> old"}]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "PATCH" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runOnboarding(tempDir, {
      AUTH_MODE: "",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, /^issue create /m);
    assert.doesNotMatch(log, /^label create /m);
    assert.match(log, /^issue edit 5 --repo self-evolving\/repo --body-file .+$/m);
    assert.match(log, /^issue edit 5 --add-label agent --repo self-evolving\/repo$/m);
    const updatedIssueBody = readOnboardingIssueBody(
      log,
      /^issue edit 5 --repo self-evolving\/repo --body-file ([^ ]*sepo-onboarding-[a-f0-9]+\.md)$/m,
    );
    assert.equal(updatedIssueBody, expectedSetupIssueBody);
    assert.doesNotMatch(updatedIssueBody, /@sepo-agent/);
    assert.match(log, /^api -X PATCH repos\/self-evolving\/repo\/issues\/comments\/123 -f body=<!-- sepo-agent-onboarding-check -->/m);
    assert.match(log, /GitHub App\/auth: not resolved/);
    assert.match(log, /Model credentials: not configured/);
    assert.match(
      log,
      /Add `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` in \[repository Actions secrets\]\(https:\/\/github.com\/self-evolving\/repo\/settings\/secrets\/actions\)\./,
    );
    assert.match(log, /Memory: not initialized/);
    assert.match(
      log,
      /Run \*\*\[Actions > Agent \/ Memory \/ Initialization\]\(https:\/\/github.com\/self-evolving\/repo\/actions\/workflows\/agent-memory-bootstrap\.yml\)\*\*\./,
    );
    assert.match(
      log,
      /Configure one model provider credential in \[repository Actions secrets\]\(https:\/\/github.com\/self-evolving\/repo\/settings\/secrets\/actions\)\./,
    );
    assert.doesNotMatch(log, /Built-in trigger labels:/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("onboarding-check CLI reports configured Anthropic API key", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-onboarding-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "label" ] && [ "$2" = "list" ]; then
  printf '%s\\n' "$4"
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/git/matching-refs/heads/* ]]; then
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '[{"number":9,"title":"Sepo setup check"}]'
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/issues/9/comments ]]; then
  printf '[{"id":456,"body":"<!-- sepo-agent-onboarding-check --> old"}]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "PATCH" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runOnboarding(tempDir, {
      AGENT_PROVIDER: "claude",
      AGENT_PROVIDER_REASON: "ANTHROPIC_API_KEY is configured",
      ANTHROPIC_API_KEY_CONFIGURED: "true",
      AUTH_MODE: "oidc_broker",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /Model credentials: `ANTHROPIC_API_KEY` configured/);
    assert.match(log, /Agent provider: `claude` \(ANTHROPIC_API_KEY is configured\)/);
    assert.doesNotMatch(log, /Model credentials: not configured/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
