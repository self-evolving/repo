import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { runDownloadGitHubAttachmentCli } from "../cli/download-github-attachment.js";
import {
  deterministicGitHubAttachmentFilename,
  downloadGitHubAttachment,
  filenameFromContentDisposition,
  isGitHubAttachmentUrl,
  normalizeGitHubAttachmentUrl,
  sanitizeGitHubAttachmentFilename,
  type GitHubAttachmentFetch,
} from "../github-attachment-download.js";

function tempAttachmentDir(): string {
  return mkdtempSync(join(tmpdir(), "github-attachment-download-"));
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

test("validates only GitHub user attachment URLs", () => {
  assert.equal(
    normalizeGitHubAttachmentUrl("https://github.com/user-attachments/files/123/report.pdf)."),
    "https://github.com/user-attachments/files/123/report.pdf",
  );
  assert.equal(
    isGitHubAttachmentUrl("https://github.com/user-attachments/assets/abc/image.png"),
    true,
  );
  assert.equal(isGitHubAttachmentUrl("https://example.com/user-attachments/files/123/nope"), false);
  assert.equal(isGitHubAttachmentUrl("https://github.com/owner/repo/files/123/nope"), false);
});

test("filename helpers parse content-disposition and sanitize path-like names", () => {
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=UTF-8''report%20final.txt"),
    "report final.txt",
  );
  assert.equal(
    sanitizeGitHubAttachmentFilename("../../secret?.txt", "fallback"),
    "secret_.txt",
  );
  assert.match(
    deterministicGitHubAttachmentFilename(
      "https://github.com/user-attachments/files/1/report.txt",
      "../../secret?.txt",
    ),
    /^github-attachment-[a-f0-9]{10}-secret_\.txt$/,
  );
});

test("downloadGitHubAttachment downloads with token and writes under output dir", async () => {
  const tempDir = tempAttachmentDir();
  try {
    let authHeader = "";
    const fetcher: GitHubAttachmentFetch = async (_url, init) => {
      authHeader = String((init?.headers as Record<string, string>).Authorization || "");
      return new Response("hello", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-disposition": "attachment; filename*=UTF-8''report%20final.txt",
        },
      });
    };

    const result = await downloadGitHubAttachment({
      url: "https://github.com/user-attachments/files/123/original.bin",
      outputDir: tempDir,
      token: "token-123",
      fetch: fetcher,
    });

    assert.equal(authHeader, "Bearer token-123");
    assert.equal(result.url, "https://github.com/user-attachments/files/123/original.bin");
    assert.equal(result.contentType, "text/plain");
    assert.equal(result.sizeBytes, 5);
    assert.equal(result.httpStatus, 200);
    assert.ok(result.localPath.startsWith(`${tempDir}/`));
    assert.ok(existsSync(result.localPath));
    assert.equal(readFileSync(result.localPath, "utf8"), "hello");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("downloadGitHubAttachment fails before fetch when token is missing", async () => {
  const tempDir = tempAttachmentDir();
  let called = false;
  const fetcher: GitHubAttachmentFetch = async () => {
    called = true;
    return new Response("should not fetch");
  };

  try {
    await assert.rejects(
      downloadGitHubAttachment({
        url: "https://github.com/user-attachments/files/123/report.txt",
        outputDir: tempDir,
        token: "",
        fetch: fetcher,
      }),
      /Missing GitHub token/,
    );
    assert.equal(called, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("downloadGitHubAttachment rejects oversized content-length before writing", async () => {
  const tempDir = tempAttachmentDir();
  try {
    const fetcher: GitHubAttachmentFetch = async () =>
      new Response("abcdef", {
        status: 200,
        headers: { "content-length": "6" },
      });

    await assert.rejects(
      downloadGitHubAttachment({
        url: "https://github.com/user-attachments/files/123/big.txt",
        outputDir: tempDir,
        token: "token-123",
        fetch: fetcher,
        maxBytes: 5,
      }),
      /content-length 6 exceeds limit 5/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("downloadGitHubAttachment rejects streamed bodies that exceed the limit", async () => {
  const tempDir = tempAttachmentDir();
  try {
    const fetcher: GitHubAttachmentFetch = async () =>
      new Response("abcdef", {
        status: 200,
      });

    await assert.rejects(
      downloadGitHubAttachment({
        url: "https://github.com/user-attachments/files/123/big.txt",
        outputDir: tempDir,
        token: "token-123",
        fetch: fetcher,
        maxBytes: 5,
      }),
      /exceeded limit 5/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("downloadGitHubAttachment applies fetch timeout", async () => {
  const tempDir = tempAttachmentDir();
  try {
    const fetcher: GitHubAttachmentFetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(abortError());
        });
      });

    await assert.rejects(
      downloadGitHubAttachment({
        url: "https://github.com/user-attachments/files/123/slow.txt",
        outputDir: tempDir,
        token: "token-123",
        fetch: fetcher,
        timeoutMs: 1,
      }),
      /Timed out after 1ms/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("downloadGitHubAttachment applies timeout while reading a stalled body", async () => {
  const tempDir = tempAttachmentDir();
  try {
    let aborted = false;
    const fetcher: GitHubAttachmentFetch = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              controller.error(abortError());
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    await assert.rejects(
      downloadGitHubAttachment({
        url: "https://github.com/user-attachments/files/123/stalled.txt",
        outputDir: tempDir,
        token: "token-123",
        fetch: fetcher,
        timeoutMs: 1,
      }),
      /Timed out after 1ms/,
    );
    assert.equal(aborted, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runDownloadGitHubAttachmentCli writes JSON metadata on success", async () => {
  const tempDir = tempAttachmentDir();
  const logs: string[] = [];
  const errors: string[] = [];
  try {
    const fetcher: GitHubAttachmentFetch = async () =>
      new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    const code = await runDownloadGitHubAttachmentCli({
      argv: ["--url", "https://github.com/user-attachments/files/123/report.txt"],
      env: {
        INPUT_GITHUB_TOKEN: "token-123",
        RUNNER_TEMP: tempDir,
      } as NodeJS.ProcessEnv,
      fetch: fetcher,
      stdout: { log: (message?: unknown) => logs.push(String(message || "")) },
      stderr: { error: (message?: unknown) => errors.push(String(message || "")) },
    });

    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    const parsed = JSON.parse(logs.join("\n")) as { localPath: string; sizeBytes: number };
    assert.equal(parsed.sizeBytes, 5);
    assert.ok(parsed.localPath.startsWith(join(tempDir, "agent-attachments")));
    assert.equal(readFileSync(parsed.localPath, "utf8"), "hello");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runDownloadGitHubAttachmentCli rejects non-attachment GitHub URLs", async () => {
  const errors: string[] = [];
  const code = await runDownloadGitHubAttachmentCli({
    argv: ["--url", "https://github.com/owner/repo/pull/1"],
    env: { INPUT_GITHUB_TOKEN: "token-123" } as NodeJS.ProcessEnv,
    fetch: async () => new Response("should not fetch"),
    stdout: { log: () => undefined },
    stderr: { error: (message?: unknown) => errors.push(String(message || "")) },
  });

  assert.equal(code, 2);
  assert.match(errors.join("\n"), /Only GitHub user attachment file or asset URLs/);
});
