import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CODEX_AUTH_LOCK_VARIABLE,
  CODEX_AUTH_STATE_VARIABLE,
  decryptManagedAuth,
  encryptManagedAuth,
  generateAuthKey,
} from "../codex-managed-auth.js";

const repoRoot = resolve(__dirname, "../../..");
const repo = "owner/private-repo";

function auth(refreshToken: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: "2026-07-11T00:33:16Z",
    tokens: {
      access_token: "access-token",
      id_token: "id-token",
      refresh_token: refreshToken,
      account_id: "account",
    },
  });
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function runCli(command: "restore" | "persist", env: Record<string, string>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [".agent/dist/cli/codex-managed-auth.js", command], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("managed Codex auth CLI restores, masks, refreshes, and removes plaintext state", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sepo-codex-auth-"));
  const variables = new Map<string, string>();
  const key = generateAuthKey();
  variables.set(CODEX_AUTH_STATE_VARIABLE, encryptManagedAuth(auth("initial-refresh"), key, repo));

  const server = createServer(async (request, response) => {
    const path = request.url || "";
    if (request.method === "GET" && (path === `/repos/${repo}` || path === `/repos/${repo}/`)) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ private: true }));
      return;
    }

    const collection = `/repos/${repo}/actions/variables`;
    if (request.method === "POST" && path === collection) {
      const body = await requestJson(request);
      const name = String(body.name || "");
      if (variables.has(name)) {
        response.writeHead(409).end();
      } else {
        variables.set(name, String(body.value || ""));
        response.writeHead(201).end();
      }
      return;
    }

    const prefix = `${collection}/`;
    if (path.startsWith(prefix)) {
      const name = decodeURIComponent(path.slice(prefix.length));
      if (request.method === "GET") {
        if (!variables.has(name)) {
          response.writeHead(404).end();
        } else {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ name, value: variables.get(name) }));
        }
        return;
      }
      if (request.method === "PATCH") {
        const body = await requestJson(request);
        variables.set(name, String(body.value || ""));
        response.writeHead(204).end();
        return;
      }
      if (request.method === "DELETE") {
        variables.delete(name);
        response.writeHead(204).end();
        return;
      }
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address() as AddressInfo;
  const githubEnv = join(tempDir, "github-env");
  writeFileSync(githubEnv, "", "utf8");
  const commonEnv = {
    CODEX_AUTH_KEY: key,
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    GITHUB_ENV: githubEnv,
    GITHUB_JOB: "answer",
    GITHUB_REPOSITORY: repo,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "42",
    HOME: tempDir,
    INPUT_GITHUB_TOKEN: "installation-token",
    RUNNER_ENVIRONMENT: "github-hosted",
  };

  try {
    const restored = await runCli("restore", commonEnv);
    assert.equal(restored.code, 0, restored.stderr);
    const restoredLog = `${restored.stdout}${restored.stderr}`;
    for (const sensitive of [key, "initial-refresh", "access-token", "id-token"]) {
      assert.match(restoredLog, new RegExp(`::add-mask::${sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
    const restoredVisibleLog = restoredLog
      .split("\n")
      .filter((line) => !line.startsWith("::add-mask::"))
      .join("\n");
    assert.doesNotMatch(restoredVisibleLog, /initial-refresh|access-token|id-token/);
    assert.ok(variables.has(CODEX_AUTH_LOCK_VARIABLE));

    const restoredEnv = Object.fromEntries(
      readFileSync(githubEnv, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    const authPath = join(restoredEnv.CODEX_HOME, "auth.json");
    assert.equal(statSync(authPath).mode & 0o777, 0o600);
    writeFileSync(authPath, auth("refreshed-token"), { encoding: "utf8", mode: 0o600 });

    const persisted = await runCli("persist", { ...commonEnv, ...restoredEnv });
    assert.equal(persisted.code, 0, persisted.stderr);
    const persistedVisibleLog = `${persisted.stdout}${persisted.stderr}`
      .split("\n")
      .filter((line) => !line.startsWith("::add-mask::"))
      .join("\n");
    assert.doesNotMatch(persistedVisibleLog, /refreshed-token|access-token|id-token/);
    assert.equal(variables.has(CODEX_AUTH_LOCK_VARIABLE), false);
    assert.equal(existsSync(authPath), false);
    const encrypted = variables.get(CODEX_AUTH_STATE_VARIABLE);
    assert.ok(encrypted);
    assert.equal(
      JSON.parse(decryptManagedAuth(encrypted, key, repo)).tokens.refresh_token,
      "refreshed-token",
    );
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    });
    rmSync(tempDir, { recursive: true, force: true });
  }
});
