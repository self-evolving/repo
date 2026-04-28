import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function writeFakeGh(tempDir: string, body: string): string {
  const fakeGh = join(tempDir, "gh");
  writeFileSync(fakeGh, body, { encoding: "utf8", mode: 0o755 });
  return fakeGh;
}

function runAddLabel(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/add-label.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...env,
    },
    encoding: "utf8",
  });
}

test("add-label CLI skips all gh calls unless AGENT_STATUS_LABEL_ENABLED is true", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-add-label-"));

  try {
    const logPath = join(tempDir, "gh.log");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 1
`,
    );

    const result = runAddLabel(tempDir, {
      AGENT_STATUS_LABEL_ENABLED: "",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /skipping status label/);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("add-label CLI creates the fixed label and applies it to issues", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-add-label-"));

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
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runAddLabel(tempDir, {
      AGENT_STATUS_LABEL_ENABLED: "true",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "42",
    });

    assert.equal(result.status, 0);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^label list --search agent --json name --jq \.\[\]\.name --repo self-evolving\/repo$/m);
    assert.match(
      log,
      /^label create agent --color 0e8a16 --description Handled by the agent --repo self-evolving\/repo$/m,
    );
    assert.match(log, /^issue edit 42 --add-label agent --repo self-evolving\/repo$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("add-label CLI treats concurrent label creation as success before applying the label", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-add-label-"));

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
  printf 'already exists\\n' >&2
  exit 1
fi
if [ "$1" = "pull_request" ] && [ "$2" = "edit" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runAddLabel(tempDir, {
      AGENT_STATUS_LABEL_ENABLED: "true",
      FAKE_GH_LOG: logPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      TARGET_KIND: "pull_request",
      TARGET_NUMBER: "12",
    });

    assert.equal(result.status, 0);
    const log = readFileSync(logPath, "utf8");
    assert.match(
      log,
      /^label create agent --color 0e8a16 --description Handled by the agent --repo self-evolving\/repo$/m,
    );
    assert.match(log, /^pr edit 12 --add-label agent --repo self-evolving\/repo$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
