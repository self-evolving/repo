import { extname } from "node:path";

export const LOCAL_SESSION_TRACE_KIND = "sepo.local_session_trace";
export const LOCAL_SESSION_TRACE_SCHEMA_VERSION = 1;
export const DEFAULT_LOCAL_SESSION_TRACE_MAX_INPUT_BYTES = 25 * 1024 * 1024;

export type LocalSessionRole = "user" | "assistant";
export type LocalSessionSourceFormat = "json" | "jsonl" | "markdown" | "text";
export type LocalSessionInputFormat = "auto" | LocalSessionSourceFormat;
export type LocalSessionOutputFormat = "json" | "jsonl";

export interface LocalSessionTraceMessage {
  role: LocalSessionRole;
  content: string;
  timestamp?: string;
}

export interface LocalSessionTraceProvenance {
  source_format: LocalSessionSourceFormat;
  provider?: string;
}

export interface LocalSessionTrace {
  kind: typeof LOCAL_SESSION_TRACE_KIND;
  schema_version: typeof LOCAL_SESSION_TRACE_SCHEMA_VERSION;
  exported_at: string;
  provenance: LocalSessionTraceProvenance;
  messages: LocalSessionTraceMessage[];
}

export interface ParseLocalSessionTraceOptions {
  inputFormat?: LocalSessionInputFormat;
  sourceName?: string;
  provider?: string;
  now?: () => Date;
}

type JsonObject = Record<string, unknown>;

const INPUT_FORMATS = new Set<LocalSessionInputFormat>([
  "auto",
  "json",
  "jsonl",
  "markdown",
  "text",
]);
const SOURCE_FORMATS = new Set<LocalSessionSourceFormat>([
  "json",
  "jsonl",
  "markdown",
  "text",
]);
const OUTPUT_FORMATS = new Set<LocalSessionOutputFormat>(["json", "jsonl"]);
const ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".bz2",
  ".gz",
  ".rar",
  ".tar",
  ".tgz",
  ".xz",
  ".zip",
]);
const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);
const DIRECT_MESSAGE_TYPES = new Set(["", "message", "user", "assistant", "human", "ai"]);
const SENSITIVE_BLOCK_NAMES = new Set([
  "env",
  "env_context",
  "env_snapshot",
  "environment",
  "environment_context",
  "environment_snapshot",
  "function_call",
  "function_result",
  "tool_call",
  "tool_output",
  "tool_result",
  "tool_use",
]);
const MAX_SENSITIVE_BLOCK_NAME_LENGTH = Math.max(
  ...[...SENSITIVE_BLOCK_NAMES].map((name) => name.length),
);

export class LocalSessionTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSessionTraceError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unsupported.length > 0) {
    throw new LocalSessionTraceError(
      `${label} contains unsupported field${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
    );
  }
}

function normalizeRole(value: unknown): LocalSessionRole | null {
  const role = String(value || "").trim().toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "ai") return "assistant";
  return null;
}

function normalizeProvider(value: string | undefined): string | undefined {
  const provider = String(value || "").trim().toLowerCase();
  if (!provider) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
    throw new LocalSessionTraceError(
      "Provider must contain only letters, numbers, dots, underscores, or hyphens (maximum 64 characters).",
    );
  }
  return provider;
}

function normalizeTimestamp(value: unknown, required: boolean, label: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new LocalSessionTraceError(`${label} is required.`);
    }
    return undefined;
  }
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    if (required) {
      throw new LocalSessionTraceError(`${label} must be an ISO-8601 timestamp.`);
    }
    return undefined;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    if (required) {
      throw new LocalSessionTraceError(`${label} must be an ISO-8601 timestamp.`);
    }
    return undefined;
  }
  return parsed.toISOString();
}

interface SensitiveTag {
  closing: boolean;
  end: number;
  name: string;
  selfClosing: boolean;
}

function isTagNameCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || value === "_"
    || value === "-"
  );
}

function isTagWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r" || value === "\f";
}

function sensitiveTagAt(content: string, start: number): SensitiveTag | null {
  let cursor = start + 1;
  const closing = content[cursor] === "/";
  if (closing) cursor += 1;

  const nameStart = cursor;
  while (
    cursor < content.length
    && cursor - nameStart <= MAX_SENSITIVE_BLOCK_NAME_LENGTH
    && isTagNameCharacter(content[cursor])
  ) {
    cursor += 1;
  }
  if (
    cursor === nameStart
    || (cursor < content.length && isTagNameCharacter(content[cursor]))
  ) {
    return null;
  }

  const name = content.slice(nameStart, cursor).toLowerCase();
  if (!SENSITIVE_BLOCK_NAMES.has(name)) return null;
  if (
    cursor < content.length
    && content[cursor] !== ">"
    && content[cursor] !== "/"
    && !isTagWhitespace(content[cursor])
  ) {
    return null;
  }

  const close = content.indexOf(">", cursor);
  if (close < 0) {
    return closing
      ? null
      : { closing: false, end: content.length, name, selfClosing: false };
  }

  if (closing) {
    for (let index = cursor; index < close; index += 1) {
      if (!isTagWhitespace(content[index])) return null;
    }
  }

  let finalCharacter = close - 1;
  while (finalCharacter >= cursor && isTagWhitespace(content[finalCharacter])) {
    finalCharacter -= 1;
  }
  return {
    closing,
    end: close + 1,
    name,
    selfClosing: !closing && content[finalCharacter] === "/",
  };
}

function removeSensitiveBlocks(content: string): string {
  const output: string[] = [];
  const openBlocks: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const tagStart = content.indexOf("<", cursor);
    if (tagStart < 0) {
      if (openBlocks.length === 0) output.push(content.slice(cursor));
      break;
    }
    if (openBlocks.length === 0) output.push(content.slice(cursor, tagStart));

    const tag = sensitiveTagAt(content, tagStart);
    if (!tag) {
      if (openBlocks.length === 0) output.push("<");
      cursor = tagStart + 1;
      continue;
    }
    cursor = tag.end;

    if (tag.closing) {
      if (openBlocks.length === 0) {
        output.push(content.slice(tagStart, tag.end));
      } else if (openBlocks[openBlocks.length - 1] === tag.name) {
        openBlocks.pop();
      }
    } else if (!tag.selfClosing) {
      openBlocks.push(tag.name);
    }
  }

  return output.join("");
}

/**
 * Applies defense-in-depth redaction to preserved user/assistant text. The
 * structured parser remains the primary boundary: it never copies arbitrary
 * metadata, environment records, reasoning, or tool blocks into the trace.
 */
export function sanitizeLocalSessionMessageContent(content: string): string {
  let sanitized = removeSensitiveBlocks(String(content || ""))
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n");

  sanitized = sanitized.replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
    "[REDACTED credential]",
  );
  sanitized = sanitized.replace(
    /(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s]+/gi,
    "$1[REDACTED credential]",
  );
  sanitized = sanitized.replace(
    /\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    "$1[REDACTED credential]@",
  );
  sanitized = sanitized.replace(
    /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
    "[REDACTED credential]",
  );
  sanitized = sanitized.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED credential]",
  );
  sanitized = sanitized.replace(
    /(\b(?=[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY))[A-Z][A-Z0-9_]*\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,}\r\n]+)/g,
    "$1[REDACTED credential]",
  );
  sanitized = sanitized.replace(
    /((?:"|')?(?:api[_ -]?key|access[_ -]?key|token|secret|password|passwd|private[_ -]?key)(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,}\r\n]+)/gi,
    "$1[REDACTED credential]",
  );

  return sanitized.replace(/\n{3,}/g, "\n\n").trim();
}

function validateMessage(value: unknown, label: string): LocalSessionTraceMessage {
  if (!isObject(value)) {
    throw new LocalSessionTraceError(`${label} must be an object.`);
  }
  assertOnlyKeys(value, ["role", "content", "timestamp"], label);

  const role = normalizeRole(value.role);
  if (!role || (value.role !== "user" && value.role !== "assistant")) {
    throw new LocalSessionTraceError(`${label}.role must be user or assistant.`);
  }
  if (typeof value.content !== "string") {
    throw new LocalSessionTraceError(`${label}.content must be a string.`);
  }
  const content = sanitizeLocalSessionMessageContent(value.content);
  if (!content) {
    throw new LocalSessionTraceError(`${label}.content must not be empty.`);
  }
  const timestamp = normalizeTimestamp(
    value.timestamp,
    value.timestamp !== undefined,
    `${label}.timestamp`,
  );

  return {
    role,
    content,
    ...(timestamp ? { timestamp } : {}),
  };
}

/** Validates and normalizes a canonical version-1 trace. */
export function validateLocalSessionTrace(value: unknown): LocalSessionTrace {
  if (!isObject(value)) {
    throw new LocalSessionTraceError("Local-session trace must be an object.");
  }
  assertOnlyKeys(
    value,
    ["kind", "schema_version", "exported_at", "provenance", "messages"],
    "Local-session trace",
  );
  if (value.kind !== LOCAL_SESSION_TRACE_KIND) {
    throw new LocalSessionTraceError(
      `Local-session trace kind must be ${LOCAL_SESSION_TRACE_KIND}.`,
    );
  }
  if (value.schema_version !== LOCAL_SESSION_TRACE_SCHEMA_VERSION) {
    throw new LocalSessionTraceError(
      `Unsupported local-session trace schema version: ${String(value.schema_version ?? "missing")}.`,
    );
  }

  const exportedAt = normalizeTimestamp(value.exported_at, true, "exported_at")!;
  if (!isObject(value.provenance)) {
    throw new LocalSessionTraceError("provenance must be an object.");
  }
  assertOnlyKeys(value.provenance, ["source_format", "provider"], "provenance");
  if (
    typeof value.provenance.source_format !== "string"
    || !SOURCE_FORMATS.has(value.provenance.source_format as LocalSessionSourceFormat)
  ) {
    throw new LocalSessionTraceError(
      "provenance.source_format must be json, jsonl, markdown, or text.",
    );
  }
  const provider = normalizeProvider(
    typeof value.provenance.provider === "string" ? value.provenance.provider : undefined,
  );
  if (value.provenance.provider !== undefined && !provider) {
    throw new LocalSessionTraceError("provenance.provider must not be empty.");
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new LocalSessionTraceError("messages must contain at least one message.");
  }

  return {
    kind: LOCAL_SESSION_TRACE_KIND,
    schema_version: LOCAL_SESSION_TRACE_SCHEMA_VERSION,
    exported_at: exportedAt,
    provenance: {
      source_format: value.provenance.source_format as LocalSessionSourceFormat,
      ...(provider ? { provider } : {}),
    },
    messages: value.messages.map((message, index) =>
      validateMessage(message, `messages[${index}]`),
    ),
  };
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .flatMap((block) => {
        if (typeof block === "string") return [block];
        if (!isObject(block)) return [];
        const type = String(block.type || "").trim().toLowerCase();
        if (!TEXT_BLOCK_TYPES.has(type) || typeof block.text !== "string") return [];
        return [block.text];
      })
      .join("\n");
  }
  if (isObject(value)) {
    const type = String(value.type || "").trim().toLowerCase();
    if (TEXT_BLOCK_TYPES.has(type) && typeof value.text === "string") {
      return value.text;
    }
  }
  return "";
}

function firstTimestamp(candidate: JsonObject, outer: JsonObject): string | undefined {
  for (const value of [
    candidate.timestamp,
    candidate.created_at,
    candidate.createdAt,
    outer.timestamp,
    outer.created_at,
    outer.createdAt,
  ]) {
    const timestamp = normalizeTimestamp(value, false, "message timestamp");
    if (timestamp) return timestamp;
  }
  return undefined;
}

/**
 * Extracts one text message from a small allowlist of common JSON transcript
 * shapes. Unknown records and all non-text content blocks are ignored.
 */
function extractMessage(value: unknown): LocalSessionTraceMessage | null {
  if (!isObject(value)) return null;
  if (value.isMeta === true || value.isSidechain === true) return null;

  let candidate = value;
  const outerType = String(value.type || "").trim().toLowerCase();

  if (outerType === "response_item") {
    if (!isObject(value.payload) || value.payload.type !== "message") return null;
    candidate = value.payload;
  } else if (outerType === "user" || outerType === "assistant") {
    if (isObject(value.message)) {
      candidate = value.message;
    } else if (typeof value.message === "string") {
      candidate = { role: outerType, content: value.message };
    }
  }

  const candidateType = String(candidate.type || "").trim().toLowerCase();
  if (!DIRECT_MESSAGE_TYPES.has(candidateType)) return null;
  const role = normalizeRole(candidate.role || (candidate === value ? candidateType : outerType));
  if (!role) return null;

  const rawContent = candidate.content ?? candidate.text
    ?? (typeof candidate.message === "string" ? candidate.message : undefined);
  const content = sanitizeLocalSessionMessageContent(extractTextContent(rawContent));
  if (!content) return null;
  const timestamp = firstTimestamp(candidate, value);

  return {
    role,
    content,
    ...(timestamp ? { timestamp } : {}),
  };
}

function inferProvider(records: unknown[]): string | undefined {
  let codex = false;
  let claude = false;
  for (const value of records) {
    if (!isObject(value)) continue;
    const type = String(value.type || "").trim().toLowerCase();
    if (
      type === "session_meta"
      || type === "turn_context"
      || type === "world_state"
      || type === "response_item"
      || (type === "event_msg" && isObject(value.payload))
    ) {
      codex = true;
    }
    if (
      type === "file-history-snapshot"
      || ((type === "user" || type === "assistant") && isObject(value.message))
    ) {
      claude = true;
    }
  }
  if (codex === claude) return undefined;
  return codex ? "codex" : "claude";
}

function resolveProvider(
  explicitProvider: string | undefined,
  inferredProvider: string | undefined,
): string | undefined {
  const explicit = normalizeProvider(explicitProvider);
  const inferred = normalizeProvider(inferredProvider);
  if (explicit && inferred && explicit !== inferred) {
    throw new LocalSessionTraceError(
      `Provider ${explicit} conflicts with detected provider ${inferred}.`,
    );
  }
  return explicit || inferred;
}

function createTrace(args: {
  messages: LocalSessionTraceMessage[];
  sourceFormat: LocalSessionSourceFormat;
  provider?: string;
  now: () => Date;
}): LocalSessionTrace {
  if (args.messages.length === 0) {
    throw new LocalSessionTraceError(
      "No user or assistant text messages were found in the local-session input.",
    );
  }
  const exportedAt = args.now();
  if (!Number.isFinite(exportedAt.getTime())) {
    throw new LocalSessionTraceError("Could not determine a valid export timestamp.");
  }
  return validateLocalSessionTrace({
    kind: LOCAL_SESSION_TRACE_KIND,
    schema_version: LOCAL_SESSION_TRACE_SCHEMA_VERSION,
    exported_at: exportedAt.toISOString(),
    provenance: {
      source_format: args.sourceFormat,
      ...(args.provider ? { provider: args.provider } : {}),
    },
    messages: args.messages,
  });
}

function recordsFromJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.messages)) return value.messages;
  return [value];
}

function parseJsonLines(input: string): unknown[] {
  const records: unknown[] = [];
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new LocalSessionTraceError(`Invalid JSONL record on line ${index + 1}.`);
    }
  }
  if (records.length === 0) {
    throw new LocalSessionTraceError("JSONL input does not contain any records.");
  }
  return records;
}

function parseCanonicalJsonLines(records: unknown[]): LocalSessionTrace | null {
  const header = records[0];
  if (!isObject(header) || header.record_type !== "trace") return null;
  assertOnlyKeys(
    header,
    ["record_type", "kind", "schema_version", "exported_at", "provenance"],
    "JSONL trace header",
  );

  const messages = records.slice(1).map((record, index) => {
    if (!isObject(record) || record.record_type !== "message") {
      throw new LocalSessionTraceError(
        `JSONL trace record ${index + 2} must have record_type message.`,
      );
    }
    assertOnlyKeys(
      record,
      ["record_type", "role", "content", "timestamp"],
      `JSONL trace record ${index + 2}`,
    );
    return {
      role: record.role,
      content: record.content,
      ...(record.timestamp !== undefined ? { timestamp: record.timestamp } : {}),
    };
  });

  return validateLocalSessionTrace({
    kind: header.kind,
    schema_version: header.schema_version,
    exported_at: header.exported_at,
    provenance: header.provenance,
    messages,
  });
}

interface RoleMarker {
  role: LocalSessionRole | null;
  inlineContent: string;
}

function roleFromLabel(value: string): LocalSessionRole | null {
  return normalizeRole(value);
}

function markdownRoleMarker(line: string): RoleMarker | null {
  const heading = line.match(
    /^\s*#{1,6}\s+(user|assistant|human|ai|system|developer|tool|function|environment|env|reasoning|thinking)(?:\s+(?:message|response|prompt|result|results|output|outputs|use|call|calls|context|snapshot))?\s*(?::\s*(.*))?$/i,
  );
  if (heading) {
    return { role: roleFromLabel(heading[1]), inlineContent: heading[2] || "" };
  }
  const bold = line.match(
    /^\s*\*\*(user|assistant|human|ai|system|developer|tool|function|environment|env|reasoning|thinking)(?:\s+(?:message|response|prompt|result|results|output|outputs|use|call|calls|context|snapshot))?\s*:\*\*\s*(.*)$/i,
  );
  if (bold) {
    return { role: roleFromLabel(bold[1]), inlineContent: bold[2] || "" };
  }
  return textRoleMarker(line);
}

function textRoleMarker(line: string): RoleMarker | null {
  const marker = line.match(
    /^\s*(?:\[(user|assistant|human|ai|system|developer|tool|function|environment|env|reasoning|thinking)(?:\s+(?:message|response|prompt|result|results|output|outputs|use|call|calls|context|snapshot))?\]|(user|assistant|human|ai|system|developer|tool|function|environment|env|reasoning|thinking)(?:\s+(?:message|response|prompt|result|results|output|outputs|use|call|calls|context|snapshot))?\s*:)(?:\s*(.*))?$/i,
  );
  if (!marker) return null;
  return {
    role: roleFromLabel(marker[1] || marker[2]),
    inlineContent: marker[3] || "",
  };
}

function parseRoleDelimitedText(
  input: string,
  format: "markdown" | "text",
): LocalSessionTraceMessage[] {
  const normalizedInput = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalizedInput.split("\n");
  const messages: LocalSessionTraceMessage[] = [];
  let activeRole: LocalSessionRole | null = null;
  let activeLines: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let sawMarker = false;

  const flush = (): void => {
    if (activeRole) {
      const content = sanitizeLocalSessionMessageContent(activeLines.join("\n"));
      if (content) messages.push({ role: activeRole, content });
    }
    activeLines = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const length = fenceMatch[1].length;
      if (!fence) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length) fence = null;
    }

    const marker = fence
      ? null
      : format === "markdown"
        ? markdownRoleMarker(line)
        : textRoleMarker(line);
    if (marker) {
      flush();
      sawMarker = true;
      activeRole = marker.role;
      if (marker.role && marker.inlineContent) activeLines.push(marker.inlineContent);
      continue;
    }
    if (activeRole) activeLines.push(line);
  }
  flush();

  if (!sawMarker) {
    const content = sanitizeLocalSessionMessageContent(normalizedInput);
    return content ? [{ role: "user", content }] : [];
  }
  return messages;
}

function extensionFormat(sourceName: string): LocalSessionSourceFormat | null {
  const extension = extname(sourceName).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".jsonl" || extension === ".ndjson") return "jsonl";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".txt" || extension === ".text" || extension === ".log") return "text";
  return null;
}

/** Detects a supported input format without reading any metadata from the host. */
export function detectLocalSessionInputFormat(
  input: string,
  sourceName = "",
): LocalSessionSourceFormat {
  const fromExtension = extensionFormat(sourceName);
  if (fromExtension) return fromExtension;

  const trimmed = input.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
      if (lines.length > 0 && lines.every((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      })) {
        return "jsonl";
      }
      throw new LocalSessionTraceError("Input looks like JSON but is not valid JSON or JSONL.");
    }
  }
  if (
    /^\s*#{1,6}\s+(?:user|assistant|human|ai|system|developer|tool|function|environment|env|reasoning|thinking)(?:\s|:|$)/im.test(trimmed)
    || /^\s*\*\*(?:user|assistant|human|ai|system|developer|tool|function|environment|env|reasoning|thinking)(?:\s|:)?/im.test(trimmed)
  ) {
    return "markdown";
  }
  return "text";
}

function applyExplicitProvider(
  trace: LocalSessionTrace,
  explicitProvider: string | undefined,
): LocalSessionTrace {
  const provider = resolveProvider(explicitProvider, trace.provenance.provider);
  return {
    ...trace,
    provenance: {
      ...trace.provenance,
      ...(provider ? { provider } : {}),
    },
  };
}

/** Parses provider records, canonical traces, or role-labelled prose into v1. */
export function parseLocalSessionTrace(
  input: string,
  options: ParseLocalSessionTraceOptions = {},
): LocalSessionTrace {
  const requestedFormat = options.inputFormat || "auto";
  if (!INPUT_FORMATS.has(requestedFormat)) {
    throw new LocalSessionTraceError(
      "Input format must be auto, json, jsonl, markdown, or text.",
    );
  }
  if (!input.trim()) {
    throw new LocalSessionTraceError("Local-session input must not be empty.");
  }

  const format = requestedFormat === "auto"
    ? detectLocalSessionInputFormat(input, options.sourceName)
    : requestedFormat;
  const now = options.now || (() => new Date());

  if (format === "markdown" || format === "text") {
    return createTrace({
      messages: parseRoleDelimitedText(input, format),
      sourceFormat: format,
      provider: normalizeProvider(options.provider),
      now,
    });
  }

  if (format === "json") {
    let value: unknown;
    try {
      value = JSON.parse(input.replace(/^\uFEFF/, ""));
    } catch {
      throw new LocalSessionTraceError("Local-session input is not valid JSON.");
    }
    if (isObject(value) && value.kind === LOCAL_SESSION_TRACE_KIND) {
      return applyExplicitProvider(validateLocalSessionTrace(value), options.provider);
    }
    const records = recordsFromJson(value);
    return createTrace({
      messages: records.flatMap((record) => {
        const message = extractMessage(record);
        return message ? [message] : [];
      }),
      sourceFormat: format,
      provider: resolveProvider(options.provider, inferProvider(records)),
      now,
    });
  }

  const records = parseJsonLines(input);
  const canonical = parseCanonicalJsonLines(records);
  if (canonical) return applyExplicitProvider(canonical, options.provider);
  if (
    records.length === 1
    && isObject(records[0])
    && records[0].kind === LOCAL_SESSION_TRACE_KIND
  ) {
    return applyExplicitProvider(validateLocalSessionTrace(records[0]), options.provider);
  }
  return createTrace({
    messages: records.flatMap((record) => {
      const message = extractMessage(record);
      return message ? [message] : [];
    }),
    sourceFormat: format,
    provider: resolveProvider(options.provider, inferProvider(records)),
    now,
  });
}

function canonicalTraceObject(trace: LocalSessionTrace): LocalSessionTrace {
  const validated = validateLocalSessionTrace(trace);
  return {
    kind: validated.kind,
    schema_version: validated.schema_version,
    exported_at: validated.exported_at,
    provenance: {
      source_format: validated.provenance.source_format,
      ...(validated.provenance.provider
        ? { provider: validated.provenance.provider }
        : {}),
    },
    messages: validated.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    })),
  };
}

/** Serializes a validated trace with deterministic fields and a final newline. */
export function serializeLocalSessionTrace(
  trace: LocalSessionTrace,
  format: LocalSessionOutputFormat = "json",
): string {
  if (!OUTPUT_FORMATS.has(format)) {
    throw new LocalSessionTraceError("Output format must be json or jsonl.");
  }
  const canonical = canonicalTraceObject(trace);
  if (format === "json") return `${JSON.stringify(canonical, null, 2)}\n`;

  const lines = [
    JSON.stringify({
      record_type: "trace",
      kind: canonical.kind,
      schema_version: canonical.schema_version,
      exported_at: canonical.exported_at,
      provenance: canonical.provenance,
    }),
    ...canonical.messages.map((message) => JSON.stringify({
      record_type: "message",
      role: message.role,
      content: message.content,
      ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    })),
  ];
  return `${lines.join("\n")}\n`;
}

function startsWithBytes(data: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => data[index] === byte);
}

/** Rejects archives and binary blobs; this foundation never extracts uploads. */
export function assertSupportedLocalSessionInput(
  sourceName: string,
  data: Uint8Array,
): void {
  const extension = extname(sourceName).toLowerCase();
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    throw new LocalSessionTraceError(
      "Archive inputs are not supported; export a JSON, JSONL, Markdown, or text transcript first.",
    );
  }
  const archiveMagic =
    startsWithBytes(data, [0x50, 0x4b, 0x03, 0x04])
    || startsWithBytes(data, [0x1f, 0x8b])
    || startsWithBytes(data, [0x42, 0x5a, 0x68])
    || startsWithBytes(data, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
    || startsWithBytes(data, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    || startsWithBytes(data, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])
    || (data.length > 262
      && String.fromCharCode(...data.slice(257, 262)) === "ustar");
  if (archiveMagic) {
    throw new LocalSessionTraceError(
      "Archive inputs are not supported; export a JSON, JSONL, Markdown, or text transcript first.",
    );
  }
  if (data.slice(0, 8192).some((byte) => byte === 0)) {
    throw new LocalSessionTraceError(
      "Binary local-session inputs are not supported; use UTF-8 JSON, JSONL, Markdown, or text.",
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new LocalSessionTraceError(
      "Binary local-session inputs are not supported; use UTF-8 JSON, JSONL, Markdown, or text.",
    );
  }
}
