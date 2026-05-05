import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function writeFakeGh(tempDir: string): string {
  const logPath = join(tempDir, "gh.log");
  writeFileSync(
    join(tempDir, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"

if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  if [ -n "\${FAKE_GH_ISSUE_BODY_PATH:-}" ]; then
    cat "$FAKE_GH_ISSUE_BODY_PATH"
    exit 0
  fi
  cat <<'BODY'
### Agent handle

@octo-agent

### Assign accepted work to the agent

Yes, assign to the configured agent handle

### Project management mode

dry-run

### GitHub Project

Do not configure a Project yet

### Project owner

_No response_

### Project title

Sepo Planning & Roadmap

### Project Status values

Inbox
In Progress
To Review
Done

### Priority field

Create Priority field with P0, P1, P2, P3

### Effort field

Create Effort field with Low, Medium, High

### Release field

Skip Release for now

### Release values

_No response_

### Additional setup notes

_No response_

### Setup confirmation

- [x] I will request \`@sepo-agent /setup plan\` first and review the proposed changes before applying them.
- [x] I understand \`@sepo-agent /setup apply\` requires a later explicit confirmation before Sepo changes repository variables or GitHub Projects.
BODY
  exit 0
fi

if [ "$1" = "variable" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"name":"AGENT_HANDLE","value":"@sepo-agent"}]'
  exit 0
fi

if [ "$1" = "variable" ] && [ "$2" = "set" ]; then
  if [ "$3" = "\${FAKE_GH_FAIL_VARIABLE:-}" ]; then
    printf 'write denied for %s\\n' "$3" >&2
    exit 2
  fi
  exit 0
fi

if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ] && [ "$4" = "repos/self-evolving/repo/issues/42/comments" ]; then
  if [ -n "\${FAKE_GH_COMMENTS:-}" ]; then
    printf '%s\\n' "$FAKE_GH_COMMENTS"
  else
    cat <<'JSON'
[[],[{"id":100,"body":"<!-- sepo-agent-setup-apply --> old"}]]
JSON
  fi
  exit 0
fi

if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "PATCH" ] && [ "$4" = "repos/self-evolving/repo/issues/comments/100" ]; then
  exit 0
fi

if [ "$1" = "issue" ] && [ "$2" = "comment" ] && [ "$3" = "42" ]; then
  exit 0
fi

printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return logPath;
}

function runSetupApply(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/setup-apply.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...env,
    },
    encoding: "utf8",
  });
}

test("setup-apply CLI applies allowlisted variables and updates marker comment", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-setup-apply-"));

  try {
    const logPath = writeFakeGh(tempDir);
    const result = runSetupApply(tempDir, {
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^issue view 42 --repo self-evolving\/repo --json body --jq \.body$/m);
    assert.match(log, /^variable set AGENT_HANDLE --body @octo-agent --repo self-evolving\/repo$/m);
    assert.match(log, /^variable set AGENT_ASSIGNMENT_ENABLED --body true --repo self-evolving\/repo$/m);
    assert.match(log, /^variable set AGENT_PROJECT_MANAGEMENT_ENABLED --body true --repo self-evolving\/repo$/m);
    assert.match(log, /^api --paginate --slurp repos\/self-evolving\/repo\/issues\/42\/comments$/m);
    assert.match(log, /^api -X PATCH repos\/self-evolving\/repo\/issues\/comments\/100 -f body=/m);
    assert.doesNotMatch(log, /gh project|project create|field-create/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("setup-apply CLI dry run skips variable writes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-setup-apply-"));

  try {
    const logPath = writeFakeGh(tempDir);
    const result = runSetupApply(tempDir, {
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      SETUP_APPLY_DRY_RUN: "true",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, /^variable set /m);
    assert.match(log, /^api -X PATCH repos\/self-evolving\/repo\/issues\/comments\/100 -f body=/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("setup-apply CLI creates the audit comment when no paginated marker exists", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-setup-apply-"));

  try {
    const logPath = writeFakeGh(tempDir);
    const result = runSetupApply(tempDir, {
      FAKE_GH_COMMENTS: "[[],[]]",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      SETUP_APPLY_DRY_RUN: "true",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api --paginate --slurp repos\/self-evolving\/repo\/issues\/42\/comments$/m);
    assert.match(log, /^issue comment 42 --body /m);
    assert.doesNotMatch(log, /^api -X PATCH repos\/self-evolving\/repo\/issues\/comments\/100/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("setup-apply CLI reports actual outcomes when variable apply fails mid-run", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-setup-apply-"));

  try {
    const logPath = writeFakeGh(tempDir);
    const result = runSetupApply(tempDir, {
      FAKE_GH_FAIL_VARIABLE: "AGENT_PROJECT_MANAGEMENT_ENABLED",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Applying AGENT_PROJECT_MANAGEMENT_ENABLED failed: write denied/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^variable set AGENT_HANDLE --body @octo-agent --repo self-evolving\/repo$/m);
    assert.match(log, /^variable set AGENT_ASSIGNMENT_ENABLED --body true --repo self-evolving\/repo$/m);
    assert.match(log, /^variable set AGENT_PROJECT_MANAGEMENT_ENABLED --body true --repo self-evolving\/repo$/m);
    assert.doesNotMatch(log, /^variable set AGENT_PROJECT_MANAGEMENT_DRY_RUN /m);
    assert.match(log, /Status: \*\*Failed\*\*/);
    assert.match(log, /\| `AGENT_HANDLE` \| `@sepo-agent` \| `@octo-agent` \| updated \|/);
    assert.match(log, /\| `AGENT_PROJECT_MANAGEMENT_ENABLED` \| _unset_ \| `true` \| failed \|/);
    assert.match(log, /\| `AGENT_PROJECT_MANAGEMENT_DRY_RUN` \| _unset_ \| `true` \| not attempted \|/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
