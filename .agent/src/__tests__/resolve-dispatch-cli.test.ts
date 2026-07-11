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

function writeFakePrViewGh(tempDir: string): void {
  writeFileSync(join(tempDir, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "pr" ] && [ "\${2-}" = "view" ]; then
  printf '{"headRefName":"agent/source","headRefOid":"abc123","isCrossRepository":false,"state":"%s"}\\n' "\${FAKE_PR_STATE-OPEN}"
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, { encoding: "utf8", mode: 0o755 });
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

test("resolve-dispatch keeps open inferred base PR metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");
    writeFakePrViewGh(tempDir);

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        FAKE_PR_STATE: "OPEN",
        GITHUB_OUTPUT: outputPath,
        AGENT_HANDLE: "@sepo-agent",
        REQUESTED_ROUTE: "implement",
        REQUEST_TEXT: "@sepo-agent /implement Add a follow-up on the open PR",
        TARGET_KIND: "pull_request",
        TARGET_NUMBER: "268",
        GITHUB_REPOSITORY: "self-evolving/repo",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /Dropping inferred base_pr/);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("base_pr"), "268");
    assert.equal(outputs.get("issue_title"), "Add a follow-up on the open PR");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch drops closed inferred base PR metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");
    writeFakePrViewGh(tempDir);

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        FAKE_PR_STATE: "CLOSED",
        GITHUB_OUTPUT: outputPath,
        AGENT_HANDLE: "@sepo-agent",
        REQUESTED_ROUTE: "implement",
        REQUEST_TEXT: "@sepo-agent /implement Recreate this as a stacked follow-up PR",
        TARGET_KIND: "pull_request",
        TARGET_NUMBER: "293",
        GITHUB_REPOSITORY: "self-evolving/repo",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stderr, /Dropping inferred base_pr #293 because source PR is closed/);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("base_pr"), "");
    assert.match(outputs.get("issue_body") || "", /Base branch note/);
    assert.match(outputs.get("issue_body") || "", /repository default branch/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch derives explicit implement tracking metadata locally", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");
    const request = "@custom-agent /implement Fix explicit implement issue titles";

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        AGENT_HANDLE: "@custom-agent",
        REQUESTED_ROUTE: "implement",
        REQUEST_TEXT: request,
        TARGET_KIND: "discussion",
        TARGET_NUMBER: "41",
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
    assert.doesNotMatch(outputs.get("issue_title") || "", /@custom-agent|\/implement/);
    assert.ok((outputs.get("issue_body") || "").includes(request));
    assert.equal(outputs.get("base_pr"), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch keeps independent PR implementation requests unstacked", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        AGENT_HANDLE: "@sepo-agent",
        REQUESTED_ROUTE: "implement",
        REQUEST_TEXT: "@sepo-agent /implement Create an independent follow-up PR",
        TARGET_KIND: "pull_request",
        TARGET_NUMBER: "268",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("issue_title"), "Create an independent follow-up PR");
    assert.equal(outputs.get("base_pr"), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch emits install route without a skill", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        REQUESTED_ROUTE: "install",
        REQUESTED_SKILL: "",
        REQUEST_TEXT: "@sepo-agent /install self-evolving/example-repo",
        TARGET_KIND: "discussion",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: JSON.stringify({
          allowed_associations: ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
          route_overrides: {
            install: ["OWNER", "MEMBER"],
            skill: ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
          },
        }),
        REPOSITORY_PRIVATE: "false",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("route"), "install");
    assert.equal(outputs.get("needs_approval"), "false");
    assert.equal(outputs.get("skill"), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch maps implicit follow-up respond to answer only", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const responsePath = join(tempDir, "followup.json");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      responsePath,
      '{"outcome":"respond","route":"orchestrate","confidence":"high","summary":"follow-up question"}',
      "utf8",
    );

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RESPONSE_FILE: responsePath,
        IMPLICIT_FOLLOWUP: "true",
        TARGET_KIND: "issue",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("route"), "answer");
    assert.equal(outputs.get("needs_approval"), "false");
    assert.equal(outputs.get("issue_title"), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch maps implicit follow-up ignore to no route", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const responsePath = join(tempDir, "followup.json");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      responsePath,
      '{"outcome":"ignore","confidence":"high","summary":"thanks"}',
      "utf8",
    );

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RESPONSE_FILE: responsePath,
        IMPLICIT_FOLLOWUP: "true",
        TARGET_KIND: "issue",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("route"), "");
    assert.equal(outputs.get("needs_approval"), "false");
    assert.equal(outputs.get("summary"), "thanks");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch ignores implicit follow-ups when answer is not authorized", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    const responsePath = join(tempDir, "followup.json");
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      responsePath,
      '{"outcome":"respond","confidence":"high","summary":"follow-up question"}',
      "utf8",
    );

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RESPONSE_FILE: responsePath,
        IMPLICIT_FOLLOWUP: "true",
        TARGET_KIND: "issue",
        AUTHOR_ASSOCIATION: "CONTRIBUTOR",
        ACCESS_POLICY: JSON.stringify({
          route_overrides: {
            answer: ["OWNER", "MEMBER"],
          },
        }),
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("route"), "");
    assert.match(outputs.get("summary") || "", /answer requests currently require/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-dispatch preflights answer authorization without intent output", () => {
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
        REQUEST_TEXT: "Can you explain the tradeoff?",
        TARGET_KIND: "issue",
        AUTHOR_ASSOCIATION: "CONTRIBUTOR",
        ACCESS_POLICY: JSON.stringify({
          route_overrides: {
            answer: ["OWNER", "MEMBER"],
          },
        }),
        REPOSITORY_PRIVATE: "true",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("route"), "unsupported");
    assert.match(outputs.get("summary") || "", /answer requests currently require/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
