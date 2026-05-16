import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  fetchDiscussionContext,
  renderPullRequestContext,
  runPrepareImplementMetadataContextCli,
} from "../cli/prepare-implement-metadata-context.js";
import type { GraphQLClient } from "../github-graphql.js";

function createBufferWriter(): {
  writer: { write(chunk: string): void };
  read(): string;
} {
  let output = "";
  return {
    writer: {
      write(chunk: string) {
        output += chunk;
      },
    },
    read() {
      return output;
    },
  };
}

function withGithubOutput<T>(outputFile: string, run: () => T): T {
  const previous = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outputFile;
  writeFileSync(outputFile, "", "utf8");
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = previous;
    }
  }
}

test("renderPullRequestContext wraps gh JSON for prompt injection", () => {
  const context = renderPullRequestContext(
    JSON.stringify({
      title: "Improve metadata titles",
      url: "https://github.com/self-evolving/repo/pull/244",
    }),
  );

  assert.match(context, /## Target Pull Request Context/);
  assert.match(context, /"title": "Improve metadata titles"/);
  assert.match(context, /```json/);
});

test("prepare implement metadata context writes pull request context", () => {
  const dir = mkdtempSync(join(tmpdir(), "implement-metadata-context-"));
  try {
    const outputFile = join(dir, "context.md");
    const stdout = createBufferWriter();
    const stderr = createBufferWriter();
    const exitCode = withGithubOutput(join(dir, "github-output.txt"), () =>
      runPrepareImplementMetadataContextCli({
        env: {
          REPO_SLUG: "self-evolving/repo",
          TARGET_KIND: "pull_request",
          TARGET_NUMBER: "244",
          TARGET_CONTEXT_FILE: outputFile,
        },
        stdout: stdout.writer,
        stderr: stderr.writer,
        fetchPullRequestContext(repoSlug, targetNumber) {
          assert.equal(repoSlug, "self-evolving/repo");
          assert.equal(targetNumber, 244);
          return "PR context\n";
        },
      }),
    );

    assert.equal(exitCode, 0);
    assert.equal(readFileSync(outputFile, "utf8"), "PR context\n");
    assert.equal(stdout.read(), "");
    assert.equal(stderr.read(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare implement metadata context writes discussion context", () => {
  const dir = mkdtempSync(join(tmpdir(), "implement-metadata-context-"));
  try {
    const outputFile = join(dir, "context.md");
    const stderr = createBufferWriter();
    const exitCode = withGithubOutput(join(dir, "github-output.txt"), () =>
      runPrepareImplementMetadataContextCli({
        env: {
          REPO_SLUG: "self-evolving/repo",
          TARGET_KIND: "discussion",
          TARGET_NUMBER: "7",
          TARGET_CONTEXT_FILE: outputFile,
        },
        stderr: stderr.writer,
        fetchDiscussionContext({ repoSlug, targetNumber }) {
          assert.equal(repoSlug, "self-evolving/repo");
          assert.equal(targetNumber, 7);
          return "Discussion transcript\n";
        },
      }),
    );

    assert.equal(exitCode, 0);
    assert.equal(readFileSync(outputFile, "utf8"), "Discussion transcript\n");
    assert.equal(stderr.read(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchDiscussionContext reuses discussion transcript helpers", () => {
  const context = fetchDiscussionContext({
    repoSlug: "self-evolving/repo",
    targetNumber: 12,
    createClient() {
      return {
        graphql<T>(): T {
          throw new Error("not used by test fetcher");
        },
      } satisfies GraphQLClient;
    },
    fetchDiscussionTranscript(_client, owner, repo, number) {
      assert.equal(owner, "self-evolving");
      assert.equal(repo, "repo");
      assert.equal(number, 12);
      return {
        discussionMeta: {
          id: "discussion-12",
          title: "Title",
          url: "https://github.com/self-evolving/repo/discussions/12",
          body: "Body",
          author: "alice",
        },
        comments: [],
      };
    },
    buildDiscussionTranscript(discussionMeta) {
      return `Transcript for ${discussionMeta.title}\n`;
    },
  });

  assert.equal(context, "Transcript for Title\n");
});

test("prepare implement metadata context rejects unsupported target kinds", () => {
  const stderr = createBufferWriter();
  const exitCode = runPrepareImplementMetadataContextCli({
    env: {
      REPO_SLUG: "self-evolving/repo",
      TARGET_KIND: "issue",
      TARGET_NUMBER: "1",
      TARGET_CONTEXT_FILE: join(tmpdir(), "unused-context.md"),
    },
    stderr: stderr.writer,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /Unsupported target kind/);
});
