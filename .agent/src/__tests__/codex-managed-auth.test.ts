import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_AUTH_LOCK_VARIABLE,
  VariableStore,
  acquireAuthLock,
  decryptManagedAuth,
  encryptManagedAuth,
  generateAuthKey,
  releaseAuthLock,
  validateManagedAuthJson,
} from "../codex-managed-auth.js";

const AUTH = JSON.stringify({
  OPENAI_API_KEY: null,
  auth_mode: "chatgpt",
  last_refresh: "2026-07-11T00:33:16Z",
  tokens: {
    access_token: "access-token",
    id_token: "id-token",
    refresh_token: "refresh-token",
    account_id: "account",
  },
});

class MemoryStore implements VariableStore {
  readonly values = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async create(name: string, value: string): Promise<boolean> {
    if (this.values.has(name)) return false;
    this.values.set(name, value);
    return true;
  }

  async update(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}

test("managed Codex auth round-trips with repository-bound authenticated encryption", () => {
  const key = generateAuthKey();
  const encrypted = encryptManagedAuth(AUTH, key, "owner/private-repo");

  assert.notEqual(encrypted, AUTH);
  assert.doesNotMatch(encrypted, /refresh-token/);
  assert.equal(decryptManagedAuth(encrypted, key, "owner/private-repo"), AUTH);
  assert.throws(() => decryptManagedAuth(encrypted, key, "owner/other-repo"), /Could not decrypt/);
});

test("managed Codex auth rejects non-ChatGPT and refresh-token-free documents", () => {
  assert.throws(() => validateManagedAuthJson("not json"), /not valid JSON/);
  assert.throws(
    () => validateManagedAuthJson(JSON.stringify({ auth_mode: "api", tokens: { refresh_token: "x" } })),
    /auth_mode "chatgpt"/,
  );
  assert.throws(
    () => validateManagedAuthJson(JSON.stringify({ auth_mode: "chatgpt", tokens: {} })),
    /missing a refresh token/,
  );
});

test("auth lock is exclusive and only its owner can release it", async () => {
  const store = new MemoryStore();
  const lock = await acquireAuthLock(store, "run-1:1:job", "run-1", {
    now: () => 1_000,
    ttlMs: 10_000,
    waitMs: 1_000,
    pollMs: 10,
  });

  assert.equal(lock.owner, "run-1:1:job");
  assert.equal(await releaseAuthLock(store, "other"), false);
  assert.ok(store.values.has(CODEX_AUTH_LOCK_VARIABLE));
  assert.equal(await releaseAuthLock(store, lock.owner), true);
  assert.equal(store.values.has(CODEX_AUTH_LOCK_VARIABLE), false);
});

test("auth lock removes stale state before acquiring", async () => {
  const store = new MemoryStore();
  store.values.set(
    CODEX_AUTH_LOCK_VARIABLE,
    JSON.stringify({
      owner: "old",
      runId: "old-run",
      acquiredAt: new Date(0).toISOString(),
      expiresAt: new Date(10).toISOString(),
    }),
  );

  const lock = await acquireAuthLock(store, "new", "new-run", {
    now: () => 100,
    ttlMs: 1_000,
    waitMs: 1_000,
    pollMs: 10,
  });
  assert.equal(lock.owner, "new");
});
