import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_AUTH_KEY_SECRET,
  CODEX_AUTH_LOCK_VARIABLE,
  CODEX_AUTH_STATE_VARIABLE,
  VariableStore,
  acquireAuthLock,
  decryptManagedAuth,
  encryptManagedAuth,
  generateAuthKey,
  managedAuthTokens,
  releaseAuthLock,
  validateManagedAuthJson,
} from "../codex-managed-auth.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim() ?? "";
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function mask(value: string): void {
  if (value) console.log(`::add-mask::${value}`);
}

function apiUrl(repo: string, suffix: string): string {
  const base = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  return `${base}/repos/${repo}/${suffix}`;
}

async function assertPrivateRepository(repo: string, token: string): Promise<void> {
  const response = await fetch(apiUrl(repo, ""), {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (!response.ok) {
    throw new Error(`Could not verify repository visibility (HTTP ${response.status})`);
  }
  const metadata = (await response.json()) as { private?: unknown };
  if (metadata.private !== true) {
    throw new Error("Managed ChatGPT authentication is restricted to private repositories");
  }
}

class GitHubVariableStore implements VariableStore {
  constructor(
    private readonly repo: string,
    private readonly token: string,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(apiUrl(this.repo, path), {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  async get(name: string): Promise<string | null> {
    const response = await this.request(`actions/variables/${encodeURIComponent(name)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub variable read failed for ${name} (HTTP ${response.status})`);
    const body = (await response.json()) as { value?: unknown };
    return typeof body.value === "string" ? body.value : null;
  }

  async create(name: string, value: string): Promise<boolean> {
    const response = await this.request("actions/variables", {
      method: "POST",
      body: JSON.stringify({ name, value }),
    });
    if (response.status === 201) return true;
    if (response.status === 409 || response.status === 422) return false;
    throw new Error(`GitHub variable create failed for ${name} (HTTP ${response.status})`);
  }

  async update(name: string, value: string): Promise<void> {
    const response = await this.request(`actions/variables/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify({ name, value }),
    });
    if (response.status === 404) {
      if (await this.create(name, value)) return;
    }
    if (!response.ok) throw new Error(`GitHub variable update failed for ${name} (HTTP ${response.status})`);
  }

  async delete(name: string): Promise<void> {
    const response = await this.request(`actions/variables/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (response.status === 404 || response.status === 204) return;
    if (!response.ok) throw new Error(`GitHub variable delete failed for ${name} (HTTP ${response.status})`);
  }
}

function appendGithubEnv(name: string, value: string): void {
  const path = requiredEnv("GITHUB_ENV");
  appendFileSync(path, `${name}=${value}\n`, "utf8");
}

function lockOwner(): string {
  return [
    requiredEnv("GITHUB_RUN_ID"),
    process.env.GITHUB_RUN_ATTEMPT?.trim() || "1",
    requiredEnv("GITHUB_JOB"),
  ].join(":");
}

function authHome(): string {
  return join(requiredEnv("HOME"), ".codex");
}

function authPath(): string {
  return join(process.env.CODEX_HOME?.trim() || authHome(), "auth.json");
}

async function restore(): Promise<void> {
  const repo = requiredEnv("GITHUB_REPOSITORY");
  const token = requiredEnv("INPUT_GITHUB_TOKEN");
  const key = requiredEnv(CODEX_AUTH_KEY_SECRET);
  if (requiredEnv("RUNNER_ENVIRONMENT") !== "github-hosted") {
    throw new Error("Managed Codex authentication is only supported on GitHub-hosted runners");
  }
  mask(key);
  const owner = lockOwner();
  const store = new GitHubVariableStore(repo, token);

  await assertPrivateRepository(repo, token);
  await acquireAuthLock(store, owner, requiredEnv("GITHUB_RUN_ID"), {
    ttlMs: positiveEnv("CODEX_AUTH_LOCK_TTL_MS"),
    waitMs: positiveEnv("CODEX_AUTH_LOCK_WAIT_MS"),
    pollMs: positiveEnv("CODEX_AUTH_LOCK_POLL_MS"),
  });

  try {
    const encrypted = await store.get(CODEX_AUTH_STATE_VARIABLE);
    if (!encrypted) {
      throw new Error(`${CODEX_AUTH_STATE_VARIABLE} is missing; run the managed Codex auth seed command`);
    }
    const plaintext = decryptManagedAuth(encrypted, key, repo);
    for (const tokenValue of managedAuthTokens(plaintext)) mask(tokenValue);

    const home = authHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    writeFileSync(join(home, "auth.json"), plaintext, { encoding: "utf8", mode: 0o600 });
    chmodSync(join(home, "auth.json"), 0o600);

    appendGithubEnv("CODEX_HOME", home);
    appendGithubEnv("SEPO_CODEX_AUTH_ENABLED", "true");
    appendGithubEnv("SEPO_CODEX_AUTH_LOCK_OWNER", owner);
    console.log("Restored encrypted managed Codex authentication.");
  } catch (error) {
    await releaseAuthLock(store, owner);
    throw error;
  }
}

async function persist(): Promise<void> {
  if ((process.env.SEPO_CODEX_AUTH_ENABLED || "").toLowerCase() !== "true") return;

  const repo = requiredEnv("GITHUB_REPOSITORY");
  const token = requiredEnv("INPUT_GITHUB_TOKEN");
  const key = requiredEnv(CODEX_AUTH_KEY_SECRET);
  const owner = requiredEnv("SEPO_CODEX_AUTH_LOCK_OWNER");
  mask(key);
  const store = new GitHubVariableStore(repo, token);
  const file = authPath();

  try {
    const plaintext = readFileSync(file, "utf8");
    validateManagedAuthJson(plaintext);
    for (const tokenValue of managedAuthTokens(plaintext)) mask(tokenValue);
    await store.update(CODEX_AUTH_STATE_VARIABLE, encryptManagedAuth(plaintext, key, repo));
    console.log("Persisted refreshed managed Codex authentication.");
  } finally {
    await releaseAuthLock(store, owner);
    rmSync(file, { force: true });
  }
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return "";
  return process.argv[index + 1]?.trim() ?? "";
}

function runGh(args: string[], input?: string): string {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout.trim();
}

function seed(): void {
  const repo = option("--repo");
  const file = option("--auth-file");
  if (!repo || !file) {
    throw new Error("Usage: codex-managed-auth seed --repo owner/name --auth-file /path/to/auth.json");
  }

  const metadata = JSON.parse(runGh(["repo", "view", repo, "--json", "visibility"])) as { visibility?: string };
  if ((metadata.visibility || "").toUpperCase() !== "PRIVATE") {
    throw new Error("Managed ChatGPT authentication is restricted to private repositories");
  }

  const plaintext = readFileSync(file, "utf8");
  validateManagedAuthJson(plaintext);
  const key = generateAuthKey();
  const encrypted = encryptManagedAuth(plaintext, key, repo);

  runGh(["secret", "set", CODEX_AUTH_KEY_SECRET, "--repo", repo], key);
  runGh(["variable", "set", CODEX_AUTH_STATE_VARIABLE, "--repo", repo, "--body", encrypted]);
  runGh(["variable", "set", "AGENT_CODEX_AUTH_MODE", "--repo", repo, "--body", "managed"]);
  runGh(["variable", "set", "AGENT_DEFAULT_PROVIDER", "--repo", repo, "--body", "codex"]);
  runGh(["variable", "set", "AGENT_RUNS_ON", "--repo", repo, "--body", '["ubuntu-latest"]']);
  runGh([
    "variable",
    "set",
    "AGENT_ACCESS_POLICY",
    "--repo",
    repo,
    "--body",
    '{"allowed_associations":["OWNER"]}',
  ]);
  console.log(`Seeded encrypted managed Codex authentication for ${repo}.`);
  console.log(`Configured ${repo} to use GitHub-hosted runners with owner-only Codex access.`);
}

async function main(): Promise<void> {
  const command = process.argv[2] || "";
  if (command === "restore") return restore();
  if (command === "persist") return persist();
  if (command === "seed") return seed();
  throw new Error("Expected one of: restore, persist, seed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
