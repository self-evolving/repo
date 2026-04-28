import { execFileSync } from "node:child_process";
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

test("extract-context skips approval commands for a configured custom mention", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        comment: {
          id: 99,
          node_id: "IC_99",
          html_url: "https://github.com/self-evolving/repo/pull/119#issuecomment-99",
          body: "@custom/agent /approve req-a1b2c3",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
        issue: {
          number: 119,
          html_url: "https://github.com/self-evolving/repo/pull/119",
          pull_request: { url: "https://api.github.com/repos/self-evolving/repo/pulls/119" },
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        INPUT_MENTION: "@custom/agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "false");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context refreshes issue author association from the GitHub API", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");
    const fakeGh = join(tempDir, "gh");

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        issue: {
          number: 2,
          title: "Investigate auth",
          body: "@sepo-agent can you investigate?",
          html_url: "https://github.com/self-evolving/repo/issues/2",
          node_id: "I_2",
          author_association: "NONE",
          user: { login: "alice" },
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      "#!/usr/bin/env bash\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/self-evolving/repo/issues/2\" ]; then\n  printf 'MEMBER\\n'\n  exit 0\nfi\nprintf 'unexpected gh args: %s\\n' \"$*\" >&2\nexit 1\n",
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issues",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "MEMBER");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context refreshes contributor issue author association from the GitHub API", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");
    const fakeGh = join(tempDir, "gh");

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        issue: {
          number: 5,
          title: "Investigate auth",
          body: "@sepo-agent /answer can you investigate?",
          html_url: "https://github.com/self-evolving/repo/issues/5",
          node_id: "I_5",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      "#!/usr/bin/env bash\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/self-evolving/repo/issues/5\" ]; then\n  printf 'MEMBER\\n'\n  exit 0\nfi\nprintf 'unexpected gh args: %s\\n' \"$*\" >&2\nexit 1\n",
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issues",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "MEMBER");
    assert.equal(outputs.get("requested_route"), "answer");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context promotes weak issue author association for repository collaborators", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");
    const fakeGh = join(tempDir, "gh");

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        issue: {
          number: 7,
          title: "Investigate auth",
          body: "@sepo-agent /answer can you investigate?",
          html_url: "https://github.com/self-evolving/repo/issues/7",
          node_id: "I_7",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/self-evolving/repo/issues/7\" ]; then",
        "  printf 'CONTRIBUTOR\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/self-evolving/repo/collaborators/alice\" ]; then",
        "  exit 0",
        "fi",
        "printf 'unexpected gh args: %s\\n' \"$*\" >&2",
        "exit 1",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issues",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "COLLABORATOR");
    assert.equal(outputs.get("requested_route"), "answer");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context preserves contributor association when refreshed issue association matches", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");
    const fakeGh = join(tempDir, "gh");

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        issue: {
          number: 6,
          title: "Investigate auth",
          body: "@sepo-agent /answer can you investigate?",
          html_url: "https://github.com/self-evolving/repo/issues/6",
          node_id: "I_6",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      "#!/usr/bin/env bash\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/self-evolving/repo/issues/6\" ]; then\n  printf 'CONTRIBUTOR\\n'\n  exit 0\nfi\nprintf 'unexpected gh args: %s\\n' \"$*\" >&2\nexit 1\n",
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issues",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "CONTRIBUTOR");
    assert.equal(outputs.get("requested_route"), "answer");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context resolves label actors as OWNER for personal repositories", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "labeled",
        sender: { login: "alice", type: "User" },
        repository: {
          private: true,
          owner: { login: "alice", type: "User" },
        },
        issue: {
          number: 7,
          title: "Queue review",
          body: "Run the review label",
          html_url: "https://github.com/alice/agent/issues/7",
          node_id: "I_7",
          author_association: "NONE",
          user: { login: "bob" },
        },
        label: { name: "agent/review" },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issues",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "alice/agent",
        INPUT_TRIGGER_KIND: "label",
        INPUT_LABEL_NAME: "agent/review",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "OWNER");
    assert.equal(outputs.get("requested_by"), "alice");
    assert.equal(outputs.get("requested_route"), "review");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context resolves label actors as MEMBER when org membership is visible", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");
    const fakeGh = join(tempDir, "gh");

    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "labeled",
        sender: { login: "alice", type: "User" },
        repository: {
          private: true,
          owner: { login: "self-evolving", type: "Organization" },
        },
        issue: {
          number: 8,
          title: "Queue implement",
          body: "Run the implementation label",
          html_url: "https://github.com/self-evolving/repo/issues/8",
          node_id: "I_8",
          author_association: "NONE",
          user: { login: "bob" },
        },
        label: { name: "agent/implement" },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      "#!/usr/bin/env bash\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"orgs/self-evolving/memberships/alice\" ]; then\n  printf 'active\\n'\n  exit 0\nfi\nprintf 'unexpected gh args: %s\\n' \"$*\" >&2\nexit 1\n",
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issues",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_TRIGGER_KIND: "label",
        INPUT_LABEL_NAME: "agent/implement",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "MEMBER");
    assert.equal(outputs.get("requested_route"), "implement");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context resolves label actors as COLLABORATOR from repository permission", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");
    const fakeGh = join(tempDir, "gh");

    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "labeled",
        sender: { login: "alice", type: "User" },
        repository: {
          private: true,
          owner: { login: "self-evolving", type: "Organization" },
        },
        issue: {
          number: 9,
          title: "Queue answer",
          body: "Run the answer label",
          html_url: "https://github.com/self-evolving/repo/issues/9",
          node_id: "I_9",
          author_association: "NONE",
          user: { login: "bob" },
        },
        label: { name: "agent/answer" },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      "#!/usr/bin/env bash\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"orgs/self-evolving/memberships/alice\" ]; then\n  exit 1\nfi\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"orgs/self-evolving/members/alice\" ]; then\n  exit 1\nfi\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/self-evolving/repo/collaborators/alice/permission\" ]; then\n  printf 'write\\n'\n  exit 0\nfi\nprintf 'unexpected gh args: %s\\n' \"$*\" >&2\nexit 1\n",
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issues",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_TRIGGER_KIND: "label",
        INPUT_LABEL_NAME: "agent/answer",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "COLLABORATOR");
    assert.equal(outputs.get("requested_route"), "answer");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context does not treat none repository permission as collaborator", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");
    const fakeGh = join(tempDir, "gh");

    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "labeled",
        sender: { login: "alice", type: "User" },
        repository: {
          private: true,
          owner: { login: "self-evolving", type: "Organization" },
        },
        issue: {
          number: 10,
          title: "Queue answer",
          body: "Run the answer label",
          html_url: "https://github.com/self-evolving/repo/issues/10",
          node_id: "I_10",
          author_association: "NONE",
          user: { login: "bob" },
        },
        label: { name: "agent/answer" },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(
      fakeGh,
      "#!/usr/bin/env bash\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"orgs/self-evolving/memberships/alice\" ]; then\n  exit 1\nfi\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"orgs/self-evolving/members/alice\" ]; then\n  exit 1\nfi\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/self-evolving/repo/collaborators/alice/permission\" ]; then\n  printf 'none\\n'\n  exit 0\nfi\nprintf 'unexpected gh args: %s\\n' \"$*\" >&2\nexit 1\n",
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issues",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        INPUT_TRIGGER_KIND: "label",
        INPUT_LABEL_NAME: "agent/answer",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "NONE");
    assert.equal(outputs.get("requested_route"), "answer");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context responds when an edited issue comment adds a mention", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "edited",
        sender: { login: "alice", type: "User" },
        comment: {
          id: 101,
          node_id: "IC_101",
          html_url: "https://github.com/self-evolving/repo/issues/164#issuecomment-101",
          body: "please check @sepo-agent",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
        changes: {
          body: {
            from: "please check",
          },
        },
        issue: {
          number: 164,
          html_url: "https://github.com/self-evolving/repo/issues/164",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("source_kind"), "issue_comment");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context skips edited issue comments when mention was already present", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "edited",
        sender: { login: "alice", type: "User" },
        comment: {
          id: 102,
          node_id: "IC_102",
          html_url: "https://github.com/self-evolving/repo/issues/164#issuecomment-102",
          body: "please check @sepo-agent again",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
        changes: {
          body: {
            from: "please check @sepo-agent",
          },
        },
        issue: {
          number: 164,
          html_url: "https://github.com/self-evolving/repo/issues/164",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "false");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context responds when an edited discussion comment adds a mention", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "edited",
        sender: { login: "alice", type: "User" },
        comment: {
          id: 103,
          node_id: "DC_103",
          html_url: "https://github.com/self-evolving/repo/discussions/164#discussioncomment-103",
          body: "please check @sepo-agent",
          authorAssociation: "CONTRIBUTOR",
          user: { login: "alice" },
        },
        changes: {
          body: {
            from: "please check",
          },
        },
        discussion: {
          number: 164,
          html_url: "https://github.com/self-evolving/repo/discussions/164",
          node_id: "D_164",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "discussion_comment",
        GITHUB_OUTPUT: outputPath,
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("source_kind"), "discussion_comment");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context responds when an edited review comment adds a mention", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        action: "edited",
        sender: { login: "alice", type: "User" },
        comment: {
          id: 104,
          node_id: "PRRC_104",
          html_url: "https://github.com/self-evolving/repo/pull/168#discussion_r104",
          body: "please check @sepo-agent",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
        changes: {
          body: {
            from: "please check",
          },
        },
        pull_request: {
          number: 168,
          html_url: "https://github.com/self-evolving/repo/pull/168",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "pull_request_review_comment",
        GITHUB_OUTPUT: outputPath,
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("source_kind"), "pull_request_review_comment");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context lets public contributor mentions reach dispatch triage", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        repository: { private: false },
        comment: {
          id: 105,
          node_id: "IC_105",
          html_url: "https://github.com/self-evolving/repo/issues/170#issuecomment-105",
          body: "please check @sepo-agent",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
        issue: {
          number: 170,
          html_url: "https://github.com/self-evolving/repo/issues/170",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "CONTRIBUTOR");
    assert.equal(outputs.get("requested_route"), "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context preserves explicit routes for later policy checks", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        repository: { private: false },
        comment: {
          id: 106,
          node_id: "IC_106",
          html_url: "https://github.com/self-evolving/repo/issues/171#issuecomment-106",
          body: "@sepo-agent /answer please check this",
          author_association: "CONTRIBUTOR",
          user: { login: "alice" },
        },
        issue: {
          number: 171,
          html_url: "https://github.com/self-evolving/repo/issues/171",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("requested_route"), "answer");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("extract-context keeps known associations available for later policy checks", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-extract-context-"));

  try {
    const eventPath = join(tempDir, "event.json");
    const outputPath = join(tempDir, "github-output.txt");

    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: "alice", type: "User" },
        comment: {
          id: 107,
          node_id: "IC_107",
          html_url: "https://github.com/self-evolving/repo/issues/172#issuecomment-107",
          body: "@sepo-agent /answer please check this",
          author_association: "NONE",
          user: { login: "alice" },
        },
        issue: {
          number: 172,
          html_url: "https://github.com/self-evolving/repo/issues/172",
        },
      }),
      "utf8",
    );
    writeFileSync(outputPath, "", "utf8");

    execFileSync("node", [".agent/dist/cli/extract-context.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_OUTPUT: outputPath,
        INPUT_MENTION: "@sepo-agent",
        INPUT_TRIGGER_KIND: "mention",
      },
      stdio: "pipe",
    });

    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("should_respond"), "true");
    assert.equal(outputs.get("association"), "NONE");
    assert.equal(outputs.get("requested_route"), "answer");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
