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

function writePlan(tempDir: string): string {
  const bodyFile = join(tempDir, "summary.md");
  writeFileSync(
    bodyFile,
    `## Project Management Summary

\`\`\`json
{
  "label_changes": [
    {
      "kind": "issue",
      "number": 34,
      "add": ["priority/p1", "effort/high", "bug"],
      "remove": ["priority/p3", "effort/low", "external"]
    },
    {
      "kind": "pull_request",
      "number": 39,
      "add": ["priority/p3", "effort/low"],
      "remove": ["priority/p2", "effort/high"]
    },
    {
      "kind": "discussion",
      "number": 7,
      "add": ["priority/p0"],
      "remove": []
    }
  ]
}
\`\`\`
`,
  );
  return bodyFile;
}

function runCli(tempDir: string, env: Record<string, string>) {
  return spawnSync("node", [".agent/dist/cli/apply-project-management-labels.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      ...env,
    },
    encoding: "utf8",
  });
}

test("apply project management labels skips gh calls in dry-run mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "apply-project-labels-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "outputs.txt");
    writePlan(tempDir);
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 1
`,
    );

    const result = runCli(tempDir, {
      AGENT_PROJECT_MANAGEMENT_DRY_RUN: "true",
      AGENT_PROJECT_MANAGEMENT_APPLY_LABELS: "true",
      BODY_FILE: join(tempDir, "summary.md"),
      FAKE_GH_LOG: logPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run is enabled/);
    assert.equal(readFileSync(outputPath, "utf8").includes("labels_applied"), true);
    assert.throws(() => readFileSync(logPath, "utf8"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("apply project management labels creates labels and applies only managed changes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "apply-project-labels-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "outputs.txt");
    writePlan(tempDir);
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
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = runCli(tempDir, {
      AGENT_PROJECT_MANAGEMENT_DRY_RUN: "false",
      AGENT_PROJECT_MANAGEMENT_APPLY_LABELS: "true",
      BODY_FILE: join(tempDir, "summary.md"),
      FAKE_GH_LOG: logPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Applied 8 managed priority\/effort label operation/);

    const log = readFileSync(logPath, "utf8");
    for (const label of [
      "priority/p0",
      "priority/p1",
      "priority/p2",
      "priority/p3",
      "effort/low",
      "effort/medium",
      "effort/high",
    ]) {
      assert.match(log, new RegExp(`^label create ${label} `, "m"));
    }
    assert.match(log, /^issue edit 34 --remove-label priority\/p3 --repo self-evolving\/repo$/m);
    assert.match(log, /^issue edit 34 --remove-label effort\/low --repo self-evolving\/repo$/m);
    assert.match(log, /^issue edit 34 --add-label priority\/p1 --repo self-evolving\/repo$/m);
    assert.match(log, /^issue edit 34 --add-label effort\/high --repo self-evolving\/repo$/m);
    assert.match(log, /^pr edit 39 --remove-label priority\/p2 --repo self-evolving\/repo$/m);
    assert.match(log, /^pr edit 39 --remove-label effort\/high --repo self-evolving\/repo$/m);
    assert.match(log, /^pr edit 39 --add-label priority\/p3 --repo self-evolving\/repo$/m);
    assert.match(log, /^pr edit 39 --add-label effort\/low --repo self-evolving\/repo$/m);
    assert.doesNotMatch(log, / bug| external|discussion/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("apply project management labels fails real label application without a valid plan", () => {
  const cases = [
    ["missing fenced json", "## Project Management Summary\n\nNo structured plan.\n"],
    ["malformed fenced json", "## Project Management Summary\n\n```json\nnot-json\n```\n"],
  ];

  for (const [name, body] of cases) {
    const tempDir = mkdtempSync(join(tmpdir(), "apply-project-labels-"));

    try {
      const bodyFile = join(tempDir, "summary.md");
      const logPath = join(tempDir, "gh.log");
      const outputPath = join(tempDir, "outputs.txt");
      writeFileSync(bodyFile, body);
      writeFakeGh(
        tempDir,
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 1
`,
      );

      const result = runCli(tempDir, {
        AGENT_PROJECT_MANAGEMENT_DRY_RUN: "false",
        AGENT_PROJECT_MANAGEMENT_APPLY_LABELS: "true",
        BODY_FILE: bodyFile,
        FAKE_GH_LOG: logPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
      });

      assert.equal(result.status, 1, name);
      assert.match(result.stderr, /valid fenced JSON label_changes plan/);
      assert.throws(() => readFileSync(logPath, "utf8"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("apply project management labels allows an explicit empty plan", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "apply-project-labels-"));

  try {
    const bodyFile = join(tempDir, "summary.md");
    const logPath = join(tempDir, "gh.log");
    const outputPath = join(tempDir, "outputs.txt");
    writeFileSync(bodyFile, "## Project Management Summary\n\n```json\n{\"label_changes\":[]}\n```\n");
    writeFakeGh(tempDir, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$FAKE_GH_LOG\"\nexit 1\n");

    const result = runCli(tempDir, {
      AGENT_PROJECT_MANAGEMENT_DRY_RUN: "false",
      AGENT_PROJECT_MANAGEMENT_APPLY_LABELS: "true",
      BODY_FILE: bodyFile,
      FAKE_GH_LOG: logPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "self-evolving/repo",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Applied 0 managed priority\/effort label operation/);
    assert.throws(() => readFileSync(logPath, "utf8"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
