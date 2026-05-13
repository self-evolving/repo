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

test("post-response CLI still posts rubrics reviews when minimization fails", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-post-response-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const bodyPath = join(tempDir, "body.md");
    writeFileSync(bodyPath, "## Rubrics Review\n\nbody\n", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf '{"errors":[{"message":"graphql unavailable"}]}\\n'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = spawnSync("node", [".agent/dist/cli/post-response.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        BODY_FILE: bodyPath,
        RESPONSE_KIND: "pr_comment",
        TARGET_NUMBER: "321",
        GITHUB_REPOSITORY: "self-evolving/repo",
        FAKE_GH_LOG: logPath,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(
      result.stderr,
      /Failed to collapse previous rubrics review comments for self-evolving\/repo#321: gh api graphql returned errors: graphql unavailable/,
    );

    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api graphql /m);
    assert.match(log, /^pr comment 321 --body ## Rubrics Review/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-response CLI skips rubrics review minimization when disabled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-post-response-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const bodyPath = join(tempDir, "body.md");
    writeFileSync(bodyPath, "## Rubrics Review\n\nbody\n", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf 'unexpected minimization call\\n' >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = spawnSync("node", [".agent/dist/cli/post-response.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        AGENT_COLLAPSE_OLD_REVIEWS: "false",
        BODY_FILE: bodyPath,
        RESPONSE_KIND: "pr_comment",
        TARGET_NUMBER: "321",
        GITHUB_REPOSITORY: "self-evolving/repo",
        FAKE_GH_LOG: logPath,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");

    const log = readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, /^api graphql /m);
    assert.match(log, /^pr comment 321 --body ## Rubrics Review/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-response CLI updates latest Sepo self-approval marker comment", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-post-response-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const bodyPath = join(tempDir, "body.md");
    writeFileSync(bodyPath, "Sepo self-approval completed.\n\n<!-- sepo-agent-self-approval -->\n", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf '{"data":{"viewer":{"login":"sepo-agent-app[bot]"}}}\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ]; then
  printf '[[{"id":111,"body":"old self marker\\\\n<!-- sepo-agent-self-approval -->","created_at":"2026-05-07T10:00:00Z","user":{"login":"sepo-agent-app"}},{"id":222,"body":"untrusted marker\\\\n<!-- sepo-agent-self-approval -->","created_at":"2026-05-07T10:05:00Z","user":{"login":"alice"}},{"id":333,"body":"latest self marker\\\\n<!-- sepo-agent-self-approval -->","created_at":"2026-05-07T10:10:00Z","user":{"login":"app/sepo-agent-app"}}]]\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "PATCH" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = spawnSync("node", [".agent/dist/cli/post-response.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        BODY_FILE: bodyPath,
        RESPONSE_KIND: "pr_comment",
        TARGET_NUMBER: "321",
        GITHUB_REPOSITORY: "self-evolving/repo",
        FAKE_GH_LOG: logPath,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated self-approval status comment/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api graphql /m);
    assert.match(log, /^api --paginate --slurp repos\/self-evolving\/repo\/issues\/321\/comments/m);
    assert.match(log, /^api --method PATCH repos\/self-evolving\/repo\/issues\/comments\/333 /m);
    assert.doesNotMatch(log, /issues\/comments\/111/);
    assert.doesNotMatch(log, /issues\/comments\/222/);
    assert.doesNotMatch(log, /^pr comment /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-response CLI updates latest Sepo self-merge marker comment", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-post-response-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const bodyPath = join(tempDir, "body.md");
    writeFileSync(bodyPath, "Sepo self-merge completed.\n\n<!-- sepo-agent-self-merge -->\n", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf '{"data":{"viewer":{"login":"sepo-agent-app[bot]"}}}\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ]; then
  printf '[[{"id":111,"body":"old merge marker\\\\n<!-- sepo-agent-self-merge -->","created_at":"2026-05-07T10:00:00Z","user":{"login":"sepo-agent-app"}},{"id":222,"body":"untrusted merge marker\\\\n<!-- sepo-agent-self-merge -->","created_at":"2026-05-07T10:05:00Z","user":{"login":"alice"}},{"id":333,"body":"latest merge marker\\\\n<!-- sepo-agent-self-merge -->","created_at":"2026-05-07T10:10:00Z","user":{"login":"app/sepo-agent-app"}}]]\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "PATCH" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = spawnSync("node", [".agent/dist/cli/post-response.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        BODY_FILE: bodyPath,
        RESPONSE_KIND: "pr_comment",
        TARGET_NUMBER: "321",
        GITHUB_REPOSITORY: "self-evolving/repo",
        FAKE_GH_LOG: logPath,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated self-merge status comment/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api graphql /m);
    assert.match(log, /^api --paginate --slurp repos\/self-evolving\/repo\/issues\/321\/comments/m);
    assert.match(log, /^api --method PATCH repos\/self-evolving\/repo\/issues\/comments\/333 /m);
    assert.doesNotMatch(log, /issues\/comments\/111/);
    assert.doesNotMatch(log, /issues\/comments\/222/);
    assert.doesNotMatch(log, /^pr comment /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-response CLI ignores untrusted self-approval marker comments", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-post-response-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const bodyPath = join(tempDir, "body.md");
    writeFileSync(bodyPath, "Sepo self-approval completed.\n\n<!-- sepo-agent-self-approval -->\n", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf '{"data":{"viewer":{"login":"sepo-agent-app"}}}\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ]; then
  printf '[[{"id":456,"body":"user marker\\\\n<!-- sepo-agent-self-approval -->","created_at":"2026-05-07T10:00:00Z","user":{"login":"someone-else"}}]]\\n'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = spawnSync("node", [".agent/dist/cli/post-response.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        BODY_FILE: bodyPath,
        RESPONSE_KIND: "pr_comment",
        TARGET_NUMBER: "321",
        GITHUB_REPOSITORY: "self-evolving/repo",
        FAKE_GH_LOG: logPath,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Created self-approval status comment/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api graphql /m);
    assert.match(log, /^api --paginate --slurp repos\/self-evolving\/repo\/issues\/321\/comments/m);
    assert.doesNotMatch(log, /^api --method PATCH /m);
    assert.match(log, /^pr comment 321 --body Sepo self-approval completed/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-response CLI does not fallback post when self-approval upsert fails", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-post-response-"));

  try {
    const logPath = join(tempDir, "gh.log");
    const bodyPath = join(tempDir, "body.md");
    writeFileSync(bodyPath, "Sepo self-approval completed.\n\n<!-- sepo-agent-self-approval -->\n", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf '{"data":{"viewer":{"login":"sepo-agent-app"}}}\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ]; then
  printf '[[{"id":789,"body":"existing marker\\\\n<!-- sepo-agent-self-approval -->","created_at":"2026-05-07T10:00:00Z","user":{"login":"sepo-agent-app"}}]]\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--method" ] && [ "$3" = "PATCH" ]; then
  printf 'patch unavailable\\n' >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  printf 'unexpected fallback post\\n' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
    );

    const result = spawnSync("node", [".agent/dist/cli/post-response.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        BODY_FILE: bodyPath,
        RESPONSE_KIND: "pr_comment",
        TARGET_NUMBER: "321",
        GITHUB_REPOSITORY: "self-evolving/repo",
        FAKE_GH_LOG: logPath,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Failed to upsert self-approval status comment for self-evolving\/repo#321:/,
    );
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^api graphql /m);
    assert.match(log, /^api --paginate --slurp repos\/self-evolving\/repo\/issues\/321\/comments/m);
    assert.match(log, /^api --method PATCH repos\/self-evolving\/repo\/issues\/comments\/789 /m);
    assert.doesNotMatch(log, /^pr comment /m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
