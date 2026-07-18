import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CODEX_AUTH_STATE_VARIABLE = "CODEX_AUTH_STATE";
export const CODEX_AUTH_LOCK_VARIABLE = "CODEX_AUTH_LOCK";
export const CODEX_AUTH_KEY_SECRET = "CODEX_AUTH_KEY";

const AUTH_STATE_VERSION = 1;
const AUTH_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const DEFAULT_LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LOCK_POLL_MS = 5_000;
const GITHUB_VARIABLE_MAX_BYTES = 48 * 1024;

interface EncryptedAuthState {
  version: 1;
  algorithm: "A256GCM";
  iv: string;
  tag: string;
  ciphertext: string;
}

interface AuthTokens {
  access_token?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
}

interface ManagedAuthDocument {
  auth_mode?: unknown;
  tokens?: AuthTokens | null;
  last_refresh?: unknown;
}

export interface AuthLock {
  owner: string;
  runId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface VariableStore {
  get(name: string): Promise<string | null>;
  create(name: string, value: string): Promise<boolean>;
  update(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface LockOptions {
  ttlMs?: number;
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function associatedData(repo: string): Buffer {
  const normalized = repo.trim().toLowerCase();
  if (!normalized.includes("/")) {
    throw new Error("Repository must use the owner/name form");
  }
  return Buffer.from(`sepo:codex-auth:${normalized}:v${AUTH_STATE_VERSION}`, "utf8");
}

export function decodeAuthKey(encoded: string): Buffer {
  const trimmed = encoded.trim();
  if (!trimmed) throw new Error(`${CODEX_AUTH_KEY_SECRET} is empty`);

  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(`${CODEX_AUTH_KEY_SECRET} must be a base64-encoded 32-byte key`);
  }
  return key;
}

export function generateAuthKey(): string {
  return randomBytes(32).toString("base64");
}

export function validateManagedAuthJson(raw: string): ManagedAuthDocument {
  let parsed: ManagedAuthDocument;
  try {
    parsed = JSON.parse(raw) as ManagedAuthDocument;
  } catch {
    throw new Error("Codex auth state is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex auth state must be a JSON object");
  }
  if (parsed.auth_mode !== "chatgpt") {
    throw new Error('Codex auth state must use auth_mode "chatgpt"');
  }
  if (!parsed.tokens || typeof parsed.tokens !== "object") {
    throw new Error("Codex auth state is missing its token bundle");
  }
  if (typeof parsed.tokens.refresh_token !== "string" || !parsed.tokens.refresh_token.trim()) {
    throw new Error("Codex auth state is missing a refresh token");
  }

  return parsed;
}

export function managedAuthTokens(raw: string): string[] {
  const parsed = validateManagedAuthJson(raw);
  const tokens = parsed.tokens ?? {};
  return [tokens.access_token, tokens.id_token, tokens.refresh_token]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function encryptManagedAuth(raw: string, encodedKey: string, repo: string): string {
  validateManagedAuthJson(raw);
  const key = decodeAuthKey(encodedKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AUTH_ALGORITHM, key, iv);
  cipher.setAAD(associatedData(repo));
  const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);

  const state: EncryptedAuthState = {
    version: AUTH_STATE_VERSION,
    algorithm: "A256GCM",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") > GITHUB_VARIABLE_MAX_BYTES) {
    throw new Error(`${CODEX_AUTH_STATE_VARIABLE} exceeds GitHub's 48 KB variable limit`);
  }
  return serialized;
}

export function decryptManagedAuth(serialized: string, encodedKey: string, repo: string): string {
  let state: EncryptedAuthState;
  try {
    state = JSON.parse(serialized) as EncryptedAuthState;
  } catch {
    throw new Error(`${CODEX_AUTH_STATE_VARIABLE} is not valid encrypted-state JSON`);
  }

  if (
    !state ||
    state.version !== AUTH_STATE_VERSION ||
    state.algorithm !== "A256GCM" ||
    typeof state.iv !== "string" ||
    typeof state.tag !== "string" ||
    typeof state.ciphertext !== "string"
  ) {
    throw new Error(`${CODEX_AUTH_STATE_VARIABLE} has an unsupported encrypted-state format`);
  }

  try {
    const decipher = createDecipheriv(
      AUTH_ALGORITHM,
      decodeAuthKey(encodedKey),
      Buffer.from(state.iv, "base64url"),
    );
    decipher.setAAD(associatedData(repo));
    decipher.setAuthTag(Buffer.from(state.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(state.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    validateManagedAuthJson(plaintext);
    return plaintext;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Codex auth state")) throw error;
    throw new Error(`Could not decrypt ${CODEX_AUTH_STATE_VARIABLE}; check the repository and ${CODEX_AUTH_KEY_SECRET}`);
  }
}

function parsePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function parseLock(raw: string): AuthLock | null {
  try {
    const value = JSON.parse(raw) as Partial<AuthLock>;
    if (
      typeof value.owner !== "string" ||
      typeof value.runId !== "string" ||
      typeof value.acquiredAt !== "string" ||
      typeof value.expiresAt !== "string"
    ) {
      return null;
    }
    return value as AuthLock;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireAuthLock(
  store: VariableStore,
  owner: string,
  runId: string,
  options: LockOptions = {},
): Promise<AuthLock> {
  if (!owner.trim()) throw new Error("Codex auth lock owner is required");
  if (!runId.trim()) throw new Error("GitHub run id is required for the Codex auth lock");

  const ttlMs = parsePositiveInteger(options.ttlMs, DEFAULT_LOCK_TTL_MS, "lock ttl");
  const waitMs = parsePositiveInteger(options.waitMs, DEFAULT_LOCK_WAIT_MS, "lock wait");
  const pollMs = parsePositiveInteger(options.pollMs, DEFAULT_LOCK_POLL_MS, "lock poll interval");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + waitMs;

  while (now() < deadline) {
    const timestamp = now();
    const lock: AuthLock = {
      owner,
      runId,
      acquiredAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + ttlMs).toISOString(),
    };

    if (await store.create(CODEX_AUTH_LOCK_VARIABLE, JSON.stringify(lock))) {
      return lock;
    }

    const existingRaw = await store.get(CODEX_AUTH_LOCK_VARIABLE);
    if (!existingRaw) continue;
    const existing = parseLock(existingRaw);
    const expiresAt = existing ? Date.parse(existing.expiresAt) : Number.NaN;
    if (!existing || !Number.isFinite(expiresAt) || expiresAt <= now()) {
      await store.delete(CODEX_AUTH_LOCK_VARIABLE);
      continue;
    }

    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }

  throw new Error(`Timed out waiting for ${CODEX_AUTH_LOCK_VARIABLE}`);
}

export async function releaseAuthLock(store: VariableStore, owner: string): Promise<boolean> {
  const existingRaw = await store.get(CODEX_AUTH_LOCK_VARIABLE);
  if (!existingRaw) return false;
  const existing = parseLock(existingRaw);
  if (!existing || existing.owner !== owner) return false;
  await store.delete(CODEX_AUTH_LOCK_VARIABLE);
  return true;
}
