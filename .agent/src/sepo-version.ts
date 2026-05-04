import { existsSync, readFileSync } from "node:fs";

export const SEPO_VERSION_SCHEMA_VERSION = 1;
export const DEFAULT_SEPO_VERSION_METADATA_PATH = ".agent/sepo-version.json";

export const SEPO_VERSION_CHANNELS = [
  "pre-release",
  "release-candidate",
  "stable",
] as const;

export type SepoVersionChannel = (typeof SEPO_VERSION_CHANNELS)[number];

export const SEPO_INSTALLED_FROM_VALUES = [
  "source",
  "release",
  "template",
  "manual-copy",
  "update",
] as const;

export type SepoInstalledFrom = (typeof SEPO_INSTALLED_FROM_VALUES)[number];

export interface SepoVersionMetadata {
  schema_version: typeof SEPO_VERSION_SCHEMA_VERSION;
  version: string;
  channel: SepoVersionChannel;
  source_repo: string;
  source_ref: string;
  source_sha: string | null;
  installed_from: SepoInstalledFrom;
  agent_files_hash: string | null;
}

const EXPECTED_FIELDS = [
  "schema_version",
  "version",
  "channel",
  "source_repo",
  "source_ref",
  "source_sha",
  "installed_from",
  "agent_files_hash",
] as const;

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SOURCE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FULL_GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const AGENT_FILES_HASH_RE = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireStringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new Error(`${field} must not include leading or trailing whitespace`);
  }
  return value;
}

function requireNullableStringField(
  payload: Record<string, unknown>,
  field: string,
): string | null {
  const value = payload[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be null or a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new Error(`${field} must not include leading or trailing whitespace`);
  }
  return value;
}

function requireEnum<T extends readonly string[]>(
  value: string,
  field: string,
  allowed: T,
): T[number] {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function parseSemverParts(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
} {
  const match = version.match(SEMVER_RE);
  if (!match) {
    throw new Error("version must be a SemVer string without a leading v");
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
  };
}

function validateVersionChannel(version: string, channel: SepoVersionChannel): void {
  const parsed = parseSemverParts(version);
  if (channel === "pre-release") {
    if (parsed.major !== 0) {
      throw new Error("pre-release channel versions must stay on the 0.x line");
    }
    return;
  }

  if (channel === "release-candidate") {
    if (
      parsed.major !== 1 ||
      parsed.minor !== 0 ||
      parsed.patch !== 0 ||
      !/^rc\.[1-9]\d*$/.test(parsed.prerelease)
    ) {
      throw new Error("release-candidate channel must use 1.0.0-rc.N");
    }
    return;
  }

  if (parsed.major < 1 || parsed.prerelease) {
    throw new Error("stable channel versions must be final 1.x or newer releases");
  }
}

export function validateSepoVersionMetadata(value: unknown): SepoVersionMetadata {
  if (!isRecord(value)) {
    throw new Error("Sepo version metadata must be a JSON object");
  }

  const expected = new Set<string>(EXPECTED_FIELDS);
  for (const field of EXPECTED_FIELDS) {
    if (!(field in value)) {
      throw new Error(`Missing required Sepo version metadata field: ${field}`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) {
      throw new Error(`Unsupported Sepo version metadata field: ${field}`);
    }
  }

  if (value.schema_version !== SEPO_VERSION_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${SEPO_VERSION_SCHEMA_VERSION}`);
  }

  const version = requireStringField(value, "version");
  const channel = requireEnum(
    requireStringField(value, "channel"),
    "channel",
    SEPO_VERSION_CHANNELS,
  );
  validateVersionChannel(version, channel);

  const sourceRepo = requireStringField(value, "source_repo");
  if (!SOURCE_REPO_RE.test(sourceRepo)) {
    throw new Error("source_repo must be a GitHub owner/repo slug");
  }

  const sourceRef = requireStringField(value, "source_ref");
  const sourceSha = requireNullableStringField(value, "source_sha");
  if (sourceSha && !FULL_GIT_SHA_RE.test(sourceSha)) {
    throw new Error("source_sha must be null or a full Git commit SHA");
  }

  const installedFrom = requireEnum(
    requireStringField(value, "installed_from"),
    "installed_from",
    SEPO_INSTALLED_FROM_VALUES,
  );
  if (installedFrom === "release" && !sourceSha) {
    throw new Error("release installs must record source_sha");
  }

  const agentFilesHash = requireNullableStringField(value, "agent_files_hash");
  if (agentFilesHash && !AGENT_FILES_HASH_RE.test(agentFilesHash)) {
    throw new Error("agent_files_hash must be null or sha256:<64 lowercase hex>");
  }

  return {
    schema_version: SEPO_VERSION_SCHEMA_VERSION,
    version,
    channel,
    source_repo: sourceRepo,
    source_ref: sourceRef,
    source_sha: sourceSha,
    installed_from: installedFrom,
    agent_files_hash: agentFilesHash,
  };
}

export function parseSepoVersionMetadataJson(raw: string): SepoVersionMetadata {
  return validateSepoVersionMetadata(JSON.parse(raw));
}

export function resolveSepoVersionMetadataPath(
  metadataPath = DEFAULT_SEPO_VERSION_METADATA_PATH,
): string {
  if (metadataPath !== DEFAULT_SEPO_VERSION_METADATA_PATH) {
    return metadataPath;
  }
  if (existsSync(DEFAULT_SEPO_VERSION_METADATA_PATH)) {
    return DEFAULT_SEPO_VERSION_METADATA_PATH;
  }
  if (existsSync("sepo-version.json")) {
    return "sepo-version.json";
  }
  return DEFAULT_SEPO_VERSION_METADATA_PATH;
}

export function readSepoVersionMetadata(
  metadataPath = DEFAULT_SEPO_VERSION_METADATA_PATH,
): SepoVersionMetadata {
  return parseSepoVersionMetadataJson(
    readFileSync(resolveSepoVersionMetadataPath(metadataPath), "utf8"),
  );
}

export function formatSepoVersionSummary(metadata: SepoVersionMetadata): string {
  const sha = metadata.source_sha ? metadata.source_sha.slice(0, 12) : "not recorded";
  const hash = metadata.agent_files_hash ? metadata.agent_files_hash : "not recorded";
  return [
    `Sepo ${metadata.version}`,
    `channel=${metadata.channel}`,
    `source=${metadata.source_repo}@${metadata.source_ref}`,
    `source_sha=${sha}`,
    `installed_from=${metadata.installed_from}`,
    `agent_files_hash=${hash}`,
  ].join(" ");
}
