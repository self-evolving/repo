import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function writeFakeGh(tempDir: string, body: string): void {
  writeFileSync(join(tempDir, "gh"), body, { encoding: "utf8", mode: 0o755 });
}

function runOnboarding(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/onboarding-check.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      GITHUB_OUTPUT: join(tempDir, "github-output"),
      RUNNER_TEMP: tempDir,
      ...env,
    },
    encoding: "utf8",
  });
}

function runBootstrap(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/installation-bootstrap.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      GITHUB_OUTPUT: join(tempDir, "github-output"),
      RUNNER_TEMP: tempDir,
      ...env,
    },
    encoding: "utf8",
  });
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
    assert.match(log, /^issue create --title Sepo setup check --body-file .+ --repo self-evolving\/repo$/m);
    assert.match(log, /^issue comment 77 --body <!-- sepo-agent-onboarding-check -->/m);
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
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "PATCH" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runOnboarding(tempDir, {
      AUTH_MODE: "github_token",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, /^issue create /m);
    assert.doesNotMatch(log, /^label create /m);
    assert.match(log, /^api -X PATCH repos\/self-evolving\/repo\/issues\/comments\/123 -f body=<!-- sepo-agent-onboarding-check -->/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("onboarding-check CLI reuses a bootstrap-created issue with test prompts", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-onboarding-"));

  try {
    const createdBodyPath = join(tempDir, "created-issue-body.md");
    const issueCreatedPath = join(tempDir, "issue-created");
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "GET" ] && [[ "$4" == repos/*/contents/.github/workflows/agent-onboarding.yml ]]; then
  printf 'gh: Not Found (HTTP 404)\\n' >&2
  exit 1
fi
if [ "$1" = "label" ] && [ "$2" = "list" ]; then
  exit 0
fi
if [ "$1" = "label" ] && [ "$2" = "create" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/git/matching-refs/heads/* ]]; then
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  if [ -f "$FAKE_ISSUE_CREATED" ]; then
    printf '[{"number":88,"title":"Sepo setup check"}]'
  else
    printf '[]'
  fi
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  cp "$6" "$FAKE_CREATED_BODY"
  touch "$FAKE_ISSUE_CREATED"
  printf 'https://github.com/self-evolving/repo/issues/88\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ] && [[ "$4" == repos/*/issues/88/comments ]]; then
  printf '[]'
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/issues/88/comments ]]; then
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

    const bootstrapResult = runBootstrap(tempDir, {
      DEFAULT_BRANCH: "main",
      FAKE_CREATED_BODY: createdBodyPath,
      FAKE_GH_LOG: logPath,
      FAKE_ISSUE_CREATED: issueCreatedPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });
    assert.equal(bootstrapResult.status, 0, bootstrapResult.stderr);

    const onboardingResult = runOnboarding(tempDir, {
      FAKE_CREATED_BODY: createdBodyPath,
      FAKE_GH_LOG: logPath,
      FAKE_ISSUE_CREATED: issueCreatedPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });
    assert.equal(onboardingResult.status, 0, onboardingResult.stderr);
    assert.match(onboardingResult.stdout, /Sepo onboarding issue is #88/);

    const createdBody = readFileSync(createdBodyPath, "utf8");
    assert.match(createdBody, /@sepo-agent \/answer Is Sepo configured correctly in this repository\?/);
    assert.match(createdBody, /@sepo-agent \/implement Create a small README update that verifies the agent can open a PR\./);
    assert.match(createdBody, /@sepo-agent \/review/);

    const log = readFileSync(logPath, "utf8");
    assert.equal((log.match(/^issue create /gm) ?? []).length, 1);
    assert.match(log, /^issue comment 88 --body <!-- sepo-agent-installation-bootstrap -->/m);
    assert.match(log, /^issue comment 88 --body <!-- sepo-agent-onboarding-check -->/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
