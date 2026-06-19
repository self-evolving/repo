import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  collectAttachmentReferences,
  collectAttachmentTextSources,
  downloadGitHubAttachments,
  extractAttachmentUrls,
  filenameFromContentDisposition,
  sanitizeAttachmentFilename,
  type AttachmentFetch,
  type GhJson,
} from "../attachments.js";
import { runDownloadAttachmentsCli } from "../cli/download-attachments.js";

function arrayBufferFromString(value: string): ArrayBuffer {
  const buffer = Buffer.from(value, "utf8");
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function headers(values: Record<string, string>): { get(name: string): string | null } {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get(name: string) {
      return normalized.get(name.toLowerCase()) || null;
    },
  };
}

test("extractAttachmentUrls finds GitHub user attachment URLs and trims markdown punctuation", () => {
  assert.deepEqual(
    extractAttachmentUrls(
      "See [file](https://github.com/user-attachments/files/123/report.pdf). " +
        "Image: https://github.com/user-attachments/assets/abc/image.png) " +
        "Ignore https://example.com/user-attachments/files/123/nope.txt",
    ),
    [
      "https://github.com/user-attachments/files/123/report.pdf",
      "https://github.com/user-attachments/assets/abc/image.png",
    ],
  );
});

test("collectAttachmentReferences dedupes by URL while retaining distinct sources", () => {
  const refs = collectAttachmentReferences([
    {
      source: { kind: "issue", id: "1", url: "https://github.com/owner/repo/issues/1" },
      body: "https://github.com/user-attachments/files/1/a.txt twice https://github.com/user-attachments/files/1/a.txt",
    },
    {
      source: { kind: "issue_comment", id: "99" },
      body: "https://github.com/user-attachments/files/1/a.txt",
    },
  ]);

  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, "https://github.com/user-attachments/files/1/a.txt");
  assert.deepEqual(
    refs[0].sources.map((source) => source.kind),
    ["issue", "issue_comment"],
  );
});

test("filename helpers parse content-disposition and sanitize path-like names", () => {
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''report%20final.txt"),
    "report final.txt",
  );
  assert.equal(
    filenameFromContentDisposition('attachment; filename="../../secret?.txt"'),
    "../../secret?.txt",
  );
  assert.equal(sanitizeAttachmentFilename("../../secret?.txt", "fallback"), "secret_.txt");
});

test("collectAttachmentTextSources scans pull request body, comments, reviews, and review comments", () => {
  const urls = {
    body: "https://github.com/user-attachments/files/1/body.txt",
    comment: "https://github.com/user-attachments/files/1/comment.txt",
    review: "https://github.com/user-attachments/files/1/review.txt",
    inline: "https://github.com/user-attachments/files/1/inline.txt",
  };
  const ghJson: GhJson = <T>(args: string[]): T => {
    const endpoint = args[args.length - 1];
    if (endpoint === "repos/owner/repo/pulls/8") {
      return {
        title: "PR",
        body: urls.body,
        html_url: "https://github.com/owner/repo/pull/8",
        user: { login: "alice" },
      } as T;
    }
    if (endpoint === "repos/owner/repo/issues/8/comments") {
      return [[{ id: 1, body: urls.comment, user: { login: "bob" } }]] as T;
    }
    if (endpoint === "repos/owner/repo/pulls/8/reviews") {
      return [[{ id: 2, body: urls.review, user: { login: "carol" } }]] as T;
    }
    if (endpoint === "repos/owner/repo/pulls/8/comments") {
      return [[{ id: 3, body: urls.inline, path: "src/file.ts", user: { login: "dan" } }]] as T;
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  const result = collectAttachmentTextSources({
    repo: "owner/repo",
    targetKind: "pull_request",
    targetNumber: 8,
    requestText: "no attachments here",
    ghJson,
  });
  const refs = collectAttachmentReferences(result.sources);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    refs.map((ref) => ref.url),
    [urls.body, urls.comment, urls.review, urls.inline],
  );
  assert.deepEqual(
    refs.map((ref) => ref.sources[0].kind),
    [
      "pull_request",
      "issue_comment",
      "pull_request_review",
      "pull_request_review_comment",
    ],
  );
});

test("downloadGitHubAttachments downloads with the GitHub token and writes a manifest entry", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-attachments-"));
  try {
    let authHeader = "";
    const fetcher: AttachmentFetch = async (_url, init) => {
      authHeader = init.headers.Authorization;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: headers({
          "content-type": "text/plain",
          "content-disposition": "attachment; filename*=UTF-8''report%20final.txt",
        }),
        async arrayBuffer() {
          return arrayBufferFromString("hello");
        },
      };
    };

    const manifest = await downloadGitHubAttachments({
      references: [
        {
          url: "https://github.com/user-attachments/files/123/original.bin",
          sources: [{ kind: "issue", id: "7" }],
        },
      ],
      outputDir: tempDir,
      repo: "owner/repo",
      targetKind: "issue",
      targetNumber: 7,
      token: "token-123",
      fetch: fetcher,
      now: new Date("2026-06-19T00:00:00Z"),
    });

    assert.equal(authHeader, "Bearer token-123");
    assert.equal(manifest.generatedAt, "2026-06-19T00:00:00.000Z");
    assert.equal(manifest.attachments[0].status, "downloaded");
    assert.equal(manifest.attachments[0].filename, "attachment-001-report_final.txt");
    assert.equal(manifest.attachments[0].contentType, "text/plain");
    assert.equal(manifest.attachments[0].sizeBytes, 5);
    assert.ok(existsSync(manifest.attachments[0].localPath));
    assert.equal(readFileSync(manifest.attachments[0].localPath, "utf8"), "hello");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("downloadGitHubAttachments records per-file errors without unauthenticated fetches", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-attachments-"));
  try {
    let called = false;
    const fetcher: AttachmentFetch = async () => {
      called = true;
      throw new Error("should not fetch without a token");
    };

    const manifest = await downloadGitHubAttachments({
      references: [
        {
          url: "https://github.com/user-attachments/files/123/report.txt",
          sources: [{ kind: "issue", id: "7" }],
        },
      ],
      outputDir: tempDir,
      repo: "owner/repo",
      targetKind: "issue",
      targetNumber: 7,
      token: "",
      fetch: fetcher,
    });

    assert.equal(called, false);
    assert.equal(manifest.attachments[0].status, "error");
    assert.match(manifest.attachments[0].error, /Missing GitHub token/);
    assert.equal(manifest.attachments[0].localPath, "");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("downloadGitHubAttachments records HTTP download errors in the manifest", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-attachments-"));
  try {
    const fetcher: AttachmentFetch = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: headers({ "content-type": "text/html" }),
      async arrayBuffer() {
        return arrayBufferFromString("");
      },
    });

    const manifest = await downloadGitHubAttachments({
      references: [
        {
          url: "https://github.com/user-attachments/files/123/report.txt",
          sources: [{ kind: "issue", id: "7" }],
        },
      ],
      outputDir: tempDir,
      repo: "owner/repo",
      targetKind: "issue",
      targetNumber: 7,
      token: "token-123",
      fetch: fetcher,
    });

    assert.equal(manifest.attachments[0].status, "error");
    assert.equal(manifest.attachments[0].httpStatus, 404);
    assert.equal(manifest.attachments[0].contentType, "text/html");
    assert.match(manifest.attachments[0].error, /HTTP 404 Not Found/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("download-attachments CLI writes a manifest for request text attachments", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-attachments-cli-"));
  const originalGithubOutput = process.env.GITHUB_OUTPUT;
  try {
    delete process.env.GITHUB_OUTPUT;
    const exitCode = await runDownloadAttachmentsCli({
      ...process.env,
      ATTACHMENTS_DIR: tempDir,
      REPO_SLUG: "owner/repo",
      TARGET_KIND: "repository",
      TARGET_NUMBER: "0",
      REQUEST_TEXT: "See https://github.com/user-attachments/files/123/report.txt",
      INPUT_GITHUB_TOKEN: "",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      GITHUB_OUTPUT: "",
    });

    const manifest = JSON.parse(readFileSync(join(tempDir, "manifest.json"), "utf8")) as {
      attachments: Array<{ url: string; status: string; error: string }>;
    };
    assert.equal(exitCode, 0);
    assert.equal(manifest.attachments.length, 1);
    assert.equal(manifest.attachments[0].url, "https://github.com/user-attachments/files/123/report.txt");
    assert.equal(manifest.attachments[0].status, "error");
    assert.match(manifest.attachments[0].error, /Missing GitHub token/);
  } finally {
    if (originalGithubOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = originalGithubOutput;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
