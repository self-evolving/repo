import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function writeFakeGh(
  tempDir: string,
  headOid: string,
  opts: { prAuthorLogin?: string; viewerLogin?: string; synthesisAuthorLogin?: string } = {},
): string {
  const prAuthorLogin = opts.prAuthorLogin || "lolipopshock";
  const viewerLogin = opts.viewerLogin || "sepo-agent-app";
  const synthesisAuthorLogin = opts.synthesisAuthorLogin || "sepo-agent-app";
  const logPath = join(tempDir, "gh.log");
  writeFileSync(join(tempDir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"author":{"login":"${prAuthorLogin}"},"headRefName":"agent/test","headRefOid":"${headOid}","isCrossRepository":false,"state":"OPEN"}\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ]; then
  printf '[[{"id":123,"body":"## AI Review Synthesis <!-- sepo-agent-review-synthesis --> <!-- sepo-agent-review-synthesis-head: abc123 --> ## Final Verdict SHIP","created_at":"2026-05-07T10:00:00Z","user":{"login":"${synthesisAuthorLogin}"}}]]\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf '{"data":{"viewer":{"login":"${viewerLogin}"}}}\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "POST" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`, { encoding: "utf8", mode: 0o755 });
  return logPath;
}

function runResolveSelfApprove(tempDir: string, responseBody: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  log: string;
} {
  const responseFile = join(tempDir, "response.md");
  const outputFile = join(tempDir, "github-output");
  writeFileSync(responseFile, responseBody, "utf8");
  writeFileSync(outputFile, "", "utf8");

  const result = spawnSync("node", [".agent/dist/cli/resolve-self-approve.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH || ""}`,
      AGENT_ALLOW_SELF_APPROVE: "true",
      EXPECTED_HEAD_SHA: "abc123",
      FAKE_GH_LOG: join(tempDir, "gh.log"),
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "self-evolving/repo",
      RESPONSE_FILE: responseFile,
      TARGET_KIND: "pull_request",
      TARGET_NUMBER: "42",
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: readFileSync(outputFile, "utf8"),
    log: readFileSync(join(tempDir, "gh.log"), "utf8"),
  };
}

test("resolve-self-approve submits approval only for matching trusted head", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-approve-cli-"));
  try {
    mkdirSync(tempDir, { recursive: true });
    writeFakeGh(tempDir, "abc123");

    const result = runResolveSelfApprove(tempDir, JSON.stringify({
      verdict: "APPROVE",
      reason: "Aligned.",
      inspected_head_sha: "abc123",
    }));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /approved<<[^\n]+\ntrue/);
    assert.match(result.output, /conclusion<<[^\n]+\napproved/);
    assert.match(result.log, /^api --method POST repos\/self-evolving\/repo\/pulls\/42\/reviews /m);
    assert.match(result.log, /commit_id=abc123/);
    assert.match(result.log, /event=APPROVE/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-approve blocks approval by the pull request author", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-approve-cli-"));
  try {
    writeFakeGh(tempDir, "abc123", {
      prAuthorLogin: "app/sepo-agent-app",
      viewerLogin: "sepo-agent-app[bot]",
    });

    const result = runResolveSelfApprove(tempDir, JSON.stringify({
      verdict: "APPROVE",
      reason: "Aligned.",
      inspected_head_sha: "abc123",
    }));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /approved<<[^\n]+\nfalse/);
    assert.match(result.output, /conclusion<<[^\n]+\nblocked/);
    assert.match(result.output, /approval actor matches the pull request author/);
    assert.doesNotMatch(result.log, /^api --method POST repos\/self-evolving\/repo\/pulls\/42\/reviews /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve-self-approve does not submit approval after head changes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-self-approve-cli-"));
  try {
    writeFakeGh(tempDir, "def456");

    const result = runResolveSelfApprove(tempDir, JSON.stringify({
      verdict: "APPROVE",
      reason: "Aligned.",
      inspected_head_sha: "abc123",
    }));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /approved<<[^\n]+\nfalse/);
    assert.match(result.output, /conclusion<<[^\n]+\nblocked/);
    assert.match(result.output, /pull request head changed/);
    assert.doesNotMatch(result.log, /^api --method POST repos\/self-evolving\/repo\/pulls\/42\/reviews /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
