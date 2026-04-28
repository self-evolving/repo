import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildApprovalRequestMarker } from "../approval.js";

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

test("resolve-approval skips agent-managed approval request comments", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-approval-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    const marker = buildApprovalRequestMarker({
      request_id: "req-a1b2c3",
      route: "implement",
      target_kind: "issue",
      target_number: 138,
    });

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "githubuser", type: "User" },
        comment: {
          id: 101,
          node_id: "IC_101",
          body: [
            "I triaged this as an `implement` request.",
            "",
            "```text",
            "@sepo-agent /approve req-a1b2c3",
            "```",
            "",
            marker,
          ].join("\n"),
          author_association: "MEMBER",
          user: { login: "githubuser" },
        },
        issue: {
          number: 138,
          html_url: "https://github.com/self-evolving/repo/issues/138",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/resolve-approval.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_MENTION: "@sepo-agent",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_dispatch"), "false");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-approval reports invalid AGENT_ACCESS_POLICY cleanly", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-approval-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        comment: {
          id: 102,
          node_id: "IC_102",
          body: "@sepo-agent /approve req-a1b2c3",
          author_association: "MEMBER",
          user: { login: "alice" },
        },
        issue: {
          number: 138,
          html_url: "https://github.com/self-evolving/repo/issues/138",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    const result = spawnSync("node", [".agent/dist/cli/resolve-approval.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_MENTION: "@sepo-agent",
        ACCESS_POLICY: "{",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid AGENT_ACCESS_POLICY:/);
    assert.doesNotMatch(result.stderr, /at parseAccessPolicy/);

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_dispatch"), "false");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-approval applies access policy to the pending request route", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-approval-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");
    const fakeGh = join(tempDir, "gh");
    const marker = buildApprovalRequestMarker({
      request_id: "req-a1b2c3",
      route: "implement",
      target_kind: "issue",
      target_number: 138,
      target_url: "https://github.com/self-evolving/repo/issues/138",
      workflow: "agent-implement.yml",
      request_text: "please implement this",
    });

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        repository: { private: true },
        comment: {
          id: 102,
          node_id: "IC_102",
          body: "@sepo-agent /approve req-a1b2c3",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
        issue: {
          number: 138,
          html_url: "https://github.com/self-evolving/repo/issues/138",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
if [ "$1" = "api" ]; then
  printf '[{"id":201,"created_at":"2026-04-23T00:00:00Z","body":%s}]\\n' "$(node -e 'process.stdout.write(JSON.stringify(process.env.MARKER_BODY))')"
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/resolve-approval.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        MARKER_BODY: `Approval request\n\n${marker}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_MENTION: "@sepo-agent",
        ACCESS_POLICY: JSON.stringify({
          allowed_associations: ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
          route_overrides: {
            implement: ["OWNER", "MEMBER"],
          },
        }),
        REPOSITORY_PRIVATE: "true",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_dispatch"), "false");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-approval permits route approvals allowed by access policy", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-approval-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");
    const fakeGh = join(tempDir, "gh");
    const marker = buildApprovalRequestMarker({
      request_id: "req-d4e5f6",
      route: "implement",
      target_kind: "issue",
      target_number: 139,
      target_url: "https://github.com/self-evolving/repo/issues/139",
      workflow: "agent-implement.yml",
      request_text: "please implement this",
    });

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        repository: { private: true },
        comment: {
          id: 103,
          node_id: "IC_103",
          body: "@sepo-agent /approve req-d4e5f6",
          author_association: "MEMBER",
          user: { login: "alice" },
        },
        issue: {
          number: 139,
          html_url: "https://github.com/self-evolving/repo/issues/139",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
if [ "$1" = "api" ]; then
  printf '[{"id":202,"created_at":"2026-04-23T00:00:00Z","body":%s}]\\n' "$(node -e 'process.stdout.write(JSON.stringify(process.env.MARKER_BODY))')"
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/resolve-approval.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        MARKER_BODY: `Approval request\n\n${marker}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_MENTION: "@sepo-agent",
        ACCESS_POLICY: JSON.stringify({
          route_overrides: {
            implement: ["OWNER", "MEMBER"],
          },
        }),
        REPOSITORY_PRIVATE: "true",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_dispatch"), "true");
    assert.equal(outputs.get("route"), "implement");
    assert.equal(outputs.get("workflow"), "agent-implement.yml");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
