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

function parseGithubOutput(path: string): Map<string, string> {
  const raw = readFileSync(path, "utf8");
  const outputs = new Map<string, string>();
  const blocks = raw.matchAll(/^([^<\n]+)<<([^\n]+)\n([\s\S]*?)\n\2$/gm);
  for (const [, name, , value] of blocks) {
    outputs.set(name, value);
  }
  return outputs;
}

function writePlan(tempDir: string): string {
  const bodyFile = join(tempDir, "config-response.md");
  writeFileSync(
    bodyFile,
    `{
  "operations": [
    {
      "action": "set",
      "name": "AGENT_AUTO_UPDATE",
      "value": "false",
      "reason": "Disable scheduled updates"
    },
    {
      "action": "unset",
      "name": "AGENT_STATUS_LABEL_ENABLED",
      "reason": "Use default label behavior"
    }
  ]
}
`,
  );
  return bodyFile;
}

function runCli(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/apply-repo-config.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...env,
    },
    encoding: "utf8",
  });
}

test("apply repo config validates dry-run plans without gh calls", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "apply-repo-config-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "outputs.txt");
    const summaryPath = join(tempDir, "summary.md");
    writePlan(tempDir);
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 1
`,
    );

    const result = runCli(tempDir, {
      AGENT_CONFIG_APPLY: "false",
      BODY_FILE: join(tempDir, "config-response.md"),
      FAKE_GH_LOG: logPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      SUMMARY_FILE: summaryPath,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Validated 2 repository variable operation/);
    assert.throws(() => readFileSync(logPath, "utf8"));

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("applied"), "false");
    assert.equal(outputs.get("operation_count"), "2");
    assert.equal(outputs.get("body_file"), summaryPath);
    assert.match(readFileSync(summaryPath, "utf8"), /Dry run only/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("apply repo config fails dry-run without a valid plan", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "apply-repo-config-"));

  try {
    const bodyFile = join(tempDir, "config-response.md");
    const outputPath = join(tempDir, "outputs.txt");
    const summaryPath = join(tempDir, "summary.md");
    writeFileSync(bodyFile, '{"operations":[]}', "utf8");

    const result = runCli(tempDir, {
      AGENT_CONFIG_APPLY: "false",
      BODY_FILE: bodyFile,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      SUMMARY_FILE: summaryPath,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /at least one operation/);
    assert.match(readFileSync(summaryPath, "utf8"), /No repository variables were changed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("apply repo config upserts and deletes repository variables", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "apply-repo-config-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "outputs.txt");
    const summaryPath = join(tempDir, "summary.md");
    writePlan(tempDir);
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
args="$*"
if [[ "$args" == "api repos/self-evolving/repo/actions/variables/AGENT_AUTO_UPDATE" ]]; then
  printf '%s\\n' '{"name":"AGENT_AUTO_UPDATE","value":"true"}'
  exit 0
fi
if [[ "$args" == "api -X PATCH repos/self-evolving/repo/actions/variables/AGENT_AUTO_UPDATE -f name=AGENT_AUTO_UPDATE -f value=false" ]]; then
  exit 0
fi
if [[ "$args" == "api repos/self-evolving/repo/actions/variables/AGENT_STATUS_LABEL_ENABLED" ]]; then
  printf '%s\\n' '{"name":"AGENT_STATUS_LABEL_ENABLED","value":"true"}'
  exit 0
fi
if [[ "$args" == "api -X DELETE repos/self-evolving/repo/actions/variables/AGENT_STATUS_LABEL_ENABLED" ]]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runCli(tempDir, {
      AGENT_CONFIG_APPLY: "true",
      BODY_FILE: join(tempDir, "config-response.md"),
      FAKE_GH_LOG: logPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      SUMMARY_FILE: summaryPath,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Applied 2 repository variable operation/);

    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api repos\/self-evolving\/repo\/actions\/variables\/AGENT_AUTO_UPDATE$/m);
    assert.match(log, /^api -X PATCH repos\/self-evolving\/repo\/actions\/variables\/AGENT_AUTO_UPDATE -f name=AGENT_AUTO_UPDATE -f value=false$/m);
    assert.match(log, /^api repos\/self-evolving\/repo\/actions\/variables\/AGENT_STATUS_LABEL_ENABLED$/m);
    assert.match(log, /^api -X DELETE repos\/self-evolving\/repo\/actions\/variables\/AGENT_STATUS_LABEL_ENABLED$/m);
    assert.match(readFileSync(summaryPath, "utf8"), /updated/);
    assert.match(readFileSync(summaryPath, "utf8"), /deleted/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("apply repo config creates missing variables and skips absent deletes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "apply-repo-config-"));

  try {
    const bodyFile = join(tempDir, "config-response.md");
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "outputs.txt");
    const summaryPath = join(tempDir, "summary.md");
    writeFileSync(
      bodyFile,
      '{"operations":[{"action":"set","name":"AGENT_AUTO_UPDATE","value":"false"},{"action":"unset","name":"AGENT_STATUS_LABEL_ENABLED"}]}',
      "utf8",
    );
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
args="$*"
if [[ "$args" == "api repos/self-evolving/repo/actions/variables/AGENT_AUTO_UPDATE" ]]; then
  printf 'gh: Not Found (HTTP 404)\\n' >&2
  exit 1
fi
if [[ "$args" == "api -X POST repos/self-evolving/repo/actions/variables -f name=AGENT_AUTO_UPDATE -f value=false" ]]; then
  exit 0
fi
if [[ "$args" == "api repos/self-evolving/repo/actions/variables/AGENT_STATUS_LABEL_ENABLED" ]]; then
  printf 'gh: Not Found (HTTP 404)\\n' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runCli(tempDir, {
      AGENT_CONFIG_APPLY: "true",
      BODY_FILE: bodyFile,
      FAKE_GH_LOG: logPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      SUMMARY_FILE: summaryPath,
    });

    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api -X POST repos\/self-evolving\/repo\/actions\/variables -f name=AGENT_AUTO_UPDATE -f value=false$/m);
    assert.doesNotMatch(log, /DELETE/);
    assert.match(readFileSync(summaryPath, "utf8"), /created/);
    assert.match(readFileSync(summaryPath, "utf8"), /absent/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("apply repo config reports partial results when a later operation fails", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "apply-repo-config-"));

  try {
    const bodyFile = join(tempDir, "config-response.md");
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "outputs.txt");
    const summaryPath = join(tempDir, "summary.md");
    writeFileSync(
      bodyFile,
      '{"operations":[{"action":"set","name":"AGENT_AUTO_UPDATE","value":"false"},{"action":"set","name":"AGENT_STATUS_LABEL_ENABLED","value":"true"}]}',
      "utf8",
    );
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
args="$*"
if [[ "$args" == "api repos/self-evolving/repo/actions/variables/AGENT_AUTO_UPDATE" ]]; then
  printf 'gh: Not Found (HTTP 404)\\n' >&2
  exit 1
fi
if [[ "$args" == "api -X POST repos/self-evolving/repo/actions/variables -f name=AGENT_AUTO_UPDATE -f value=false" ]]; then
  exit 0
fi
if [[ "$args" == "api repos/self-evolving/repo/actions/variables/AGENT_STATUS_LABEL_ENABLED" ]]; then
  printf '%s\\n' '{"name":"AGENT_STATUS_LABEL_ENABLED","value":"false"}'
  exit 0
fi
if [[ "$args" == "api -X PATCH repos/self-evolving/repo/actions/variables/AGENT_STATUS_LABEL_ENABLED -f name=AGENT_STATUS_LABEL_ENABLED -f value=true" ]]; then
  printf 'gh: server unavailable (HTTP 503)\\n' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runCli(tempDir, {
      AGENT_CONFIG_APPLY: "true",
      BODY_FILE: bodyFile,
      FAKE_GH_LOG: logPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
      SUMMARY_FILE: summaryPath,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Failed to apply repository variable AGENT_STATUS_LABEL_ENABLED/);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("applied"), "false");
    assert.equal(outputs.get("operation_count"), "2");
    const summary = readFileSync(summaryPath, "utf8");
    assert.match(summary, /created/);
    assert.match(summary, /failed: /);
    assert.match(summary, /failed after 1 operation\(s\) changed state/);
    assert.doesNotMatch(summary, /No repository variables were changed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
