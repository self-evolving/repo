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

test("resolve-dispatch uses generated metadata for explicit implement tracking issues", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const metadataPath = join(tempDir, "metadata.json");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      metadataPath,
      JSON.stringify({
        issue_title: "Fix explicit implement issue titles",
        issue_body: "## Goal\nGenerate titles from PR context.\n\n## Acceptance criteria\n- Ignore earlier prose command mentions.",
        base_pr: "268",
      }),
      "utf8",
    );

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RESPONSE_FILE: metadataPath,
        REQUESTED_ROUTE: "implement",
        REQUEST_TEXT: "Earlier prose mentions /implement with stale wording.\n\n@sepo-agent /implement",
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
    assert.equal(outputs.get("issue_title"), "Fix explicit implement issue titles");
    assert.doesNotMatch(outputs.get("issue_title") || "", /stale wording/);
    assert.match(outputs.get("issue_body") || "", /Generate titles from PR context/);
    assert.equal(outputs.get("base_pr"), "268");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch falls back when generated implement metadata is invalid", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const metadataPath = join(tempDir, "metadata.json");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(metadataPath, '{"issue_title":"Missing body"}', "utf8");

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RESPONSE_FILE: metadataPath,
        REQUESTED_ROUTE: "implement",
        REQUEST_TEXT: "@sepo-agent /implement",
        TARGET_KIND: "pull_request",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stderr, /using fallback metadata/);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("issue_title"), "Implement requested change");
    assert.match(outputs.get("issue_body") || "", /Original request/);
    assert.equal(outputs.get("base_pr"), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch rejects invalid implement base PR metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const metadataPath = join(tempDir, "metadata.json");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      metadataPath,
      JSON.stringify({
        issue_title: "Stack follow-up work",
        issue_body: "## Goal\nCreate a stacked follow-up PR.",
        base_pr: "#268",
      }),
      "utf8",
    );

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RESPONSE_FILE: metadataPath,
        REQUESTED_ROUTE: "implement",
        REQUEST_TEXT: "@sepo-agent /implement work on this as a stacked PR?",
        TARGET_KIND: "pull_request",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stderr, /base_pr must be a positive integer/);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("base_pr"), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
