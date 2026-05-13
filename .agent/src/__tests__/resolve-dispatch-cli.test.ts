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

test("resolve-dispatch reports invalid AGENT_ACCESS_POLICY cleanly", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        REQUESTED_ROUTE: "answer",
        REQUEST_TEXT: "@sepo-agent /answer please check this",
        TARGET_KIND: "issue",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "{",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid AGENT_ACCESS_POLICY:/);
    assert.doesNotMatch(result.stderr, /at parseAccessPolicy/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch uses generated metadata for explicit implement", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const responsePath = join(tempDir, "metadata.json");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      responsePath,
      JSON.stringify({
        route: "implement",
        needs_approval: false,
        summary: "I’ll start implementing this request.",
        confidence: "high",
        issue_title: "Generate contextual implement issue titles",
        issue_body: "## Goal\nGenerate issue metadata from PR context.",
      }),
      "utf8",
    );

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RESPONSE_FILE: responsePath,
        REQUESTED_ROUTE: "implement",
        REQUEST_TEXT: "@sepo-agent /implement please fix this",
        TARGET_KIND: "pull_request",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("route"), "implement");
    assert.equal(outputs.get("needs_approval"), "false");
    assert.equal(outputs.get("issue_title"), "Generate contextual implement issue titles");
    assert.equal(outputs.get("issue_body"), "## Goal\nGenerate issue metadata from PR context.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch ignores generated metadata for a different route", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const responsePath = join(tempDir, "metadata.json");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      responsePath,
      JSON.stringify({
        route: "answer",
        needs_approval: false,
        summary: "Wrong route.",
        confidence: "high",
        issue_title: "Wrong generated title",
        issue_body: "Wrong body.",
      }),
      "utf8",
    );

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RESPONSE_FILE: responsePath,
        REQUESTED_ROUTE: "implement",
        REQUEST_TEXT: "@sepo-agent /implement please fix this",
        TARGET_KIND: "pull_request",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stderr, /Ignoring generated issue metadata/);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("route"), "implement");
    assert.equal(outputs.get("needs_approval"), "false");
    assert.equal(outputs.get("issue_title"), "Implement requested change");
    assert.notEqual(outputs.get("issue_title"), "Wrong generated title");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
