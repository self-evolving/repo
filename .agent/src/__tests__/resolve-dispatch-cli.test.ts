import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function parseGithubOutput(path: string): Map<string, string> {
  const output = new Map<string, string>();
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const heredoc = line.match(/^([^=<>]+)<<(.+)$/);
    if (heredoc) {
      const key = heredoc[1]!;
      const delimiter = heredoc[2]!;
      const values: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== delimiter) {
        values.push(lines[i] || "");
        i += 1;
      }
      output.set(key, values.join("\n"));
      continue;
    }

    const assignment = line.match(/^([^=]+)=(.*)$/);
    if (assignment) {
      output.set(assignment[1]!, assignment[2]!);
    }
  }

  return output;
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

test("resolve-dispatch maps explicit update route to update-agent skill", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-resolve-dispatch-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");

    const result = spawnSync("node", [".agent/dist/cli/resolve-dispatch.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        REQUESTED_ROUTE: "update",
        REQUEST_TEXT: "@sepo-agent /update",
        TARGET_KIND: "issue",
        AUTHOR_ASSOCIATION: "MEMBER",
        ACCESS_POLICY: "",
        REPOSITORY_PRIVATE: "false",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    const outputs = parseGithubOutput(outputPath);
    assert.equal(outputs.get("route"), "update");
    assert.equal(outputs.get("needs_approval"), "false");
    assert.equal(outputs.get("skill"), "update-agent");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
