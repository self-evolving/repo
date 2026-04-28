import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  parseDiscussionNumber,
  resolveRepoSlug,
  runFetchDiscussionTranscriptCli,
} from "../cli/fetch-discussion-transcript.js";
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

test("parseDiscussionNumber accepts positive integers only", () => {
  assert.equal(parseDiscussionNumber("12"), 12);
  assert.equal(parseDiscussionNumber("0"), null);
  assert.equal(parseDiscussionNumber("-3"), null);
  assert.equal(parseDiscussionNumber("abc"), null);
  assert.equal(parseDiscussionNumber(undefined), null);
});

test("resolveRepoSlug prefers REPO_SLUG from env", () => {
  let called = false;
  const repoSlug = resolveRepoSlug({
    env: { REPO_SLUG: "self-evolving/repo" },
    execGh() {
      called = true;
      throw new Error("should not execute gh");
    },
  });

  assert.equal(repoSlug, "self-evolving/repo");
  assert.equal(called, false);
});

test("resolveRepoSlug falls back to gh repo view", () => {
  const repoSlug = resolveRepoSlug({
    env: {},
    execGh() {
      return Buffer.from("self-evolving/repo\n", "utf8");
    },
  });

  assert.equal(repoSlug, "self-evolving/repo");
});

test("runFetchDiscussionTranscriptCli prints usage for missing or invalid numbers", () => {
  const stdout = createBufferWriter();
  const stderr = createBufferWriter();

  const exitCode = runFetchDiscussionTranscriptCli([], {
    stdout: stdout.writer,
    stderr: stderr.writer,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.read(), "");
  assert.match(stderr.read(), /Usage: fetch-discussion-transcript\.js/);
});

test("runFetchDiscussionTranscriptCli reports repository resolution failures", () => {
  const stdout = createBufferWriter();
  const stderr = createBufferWriter();

  const exitCode = runFetchDiscussionTranscriptCli(["12"], {
    env: {},
    stdout: stdout.writer,
    stderr: stderr.writer,
    resolveRepoSlug() {
      return "";
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.read(), "");
  assert.match(stderr.read(), /Could not determine repository/);
});

test("runFetchDiscussionTranscriptCli renders the transcript on success", () => {
  const stdout = createBufferWriter();
  const stderr = createBufferWriter();
  let receivedOwner = "";
  let receivedRepo = "";
  let receivedNumber = 0;

  const exitCode = runFetchDiscussionTranscriptCli(["12"], {
    env: { REPO_SLUG: "self-evolving/repo" },
    stdout: stdout.writer,
    stderr: stderr.writer,
    createClient() {
      return {
        graphql<T>(): T {
          throw new Error("not used by test fetcher");
        },
      } satisfies GraphQLClient;
    },
    fetchDiscussionTranscript(_client, owner, repo, number) {
      receivedOwner = owner;
      receivedRepo = repo;
      receivedNumber = number;
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

  assert.equal(exitCode, 0);
  assert.equal(receivedOwner, "self-evolving");
  assert.equal(receivedRepo, "repo");
  assert.equal(receivedNumber, 12);
  assert.equal(stdout.read(), "Transcript for Title\n");
  assert.equal(stderr.read(), "");
});

test("runFetchDiscussionTranscriptCli reports fetch failures to stderr", () => {
  const stdout = createBufferWriter();
  const stderr = createBufferWriter();

  const exitCode = runFetchDiscussionTranscriptCli(["12"], {
    env: { REPO_SLUG: "self-evolving/repo" },
    stdout: stdout.writer,
    stderr: stderr.writer,
    createClient() {
      return {
        graphql<T>(): T {
          throw new Error("not used by failing test");
        },
      } satisfies GraphQLClient;
    },
    fetchDiscussionTranscript() {
      throw new Error("Discussion #12 not found");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.read(), "");
  assert.match(stderr.read(), /Discussion #12 not found/);
});
