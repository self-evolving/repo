// Thin acpx adapter.
//
// Wraps acpx CLI calls with: preflight checks, session naming via
// `sessions ensure`, identity reconciliation, per-route permission mode,
// and output mode selection.
//
// Resume policy:
// - session mode is explicit (`exec` or `persistent`)
// - workflows provide `session_policy`; the adapter does not hard-code routes
// - the adapter reports whether the session was resumed, freshly created,
//   fell back to fresh after resume failure, or failed before the run.

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Types ---

export interface AcpxRunOptions {
  /** The agent to use (e.g., "codex", "claude") */
  agent: string;
  /** The prompt text */
  prompt: string;
  /** Smaller prompt for a successfully resumed destination session. */
  continuationPrompt?: string;
  /** Working directory for the acpx process */
  cwd: string;
  /** Explicit execution mode: one-shot exec or persistent named session */
  sessionMode: "exec" | "persistent";
  /** Thread key for session naming (persistent lanes only) */
  threadKey?: string;
  /** Permission mode override */
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
  /** Timeout in seconds */
  timeout?: number;
  /** Optional session thought level for persistent lanes */
  thoughtLevel?: string;
  /** Prior ACP session ID to resume (when workflow opts in) */
  resumeSessionId?: string;
  /** Extra environment variables */
  env?: Record<string, string>;
}

export type PermissionMode = "approve-all" | "approve-reads" | "deny-all";

export type SessionEnsureOutcome =
  | { kind: "not_applicable" }
  | { kind: "fresh" }
  | { kind: "resumed"; resumedFromSessionId: string }
  | { kind: "resume_fallback"; resumedFromSessionId: string; error: string }
  | { kind: "failed"; error: string; resumedFromSessionId?: string };

export interface AcpxRunResult {
  exitCode: number;
  /** Final assistant message extracted from the session */
  stdout: string;
  /** Raw acpx stdout (typically NDJSON) */
  rawStdout: string;
  stderr: string;
  /** Compacted session log (merged tokens, structured events) */
  sessionLog: string;
  sessionName?: string;
  /** Structured outcome of session ensure/resume before the run */
  sessionEnsureOutcome: SessionEnsureOutcome;
}

export interface PreflightResult {
  ok: boolean;
  missing: string[];
}

export interface SessionIdentity {
  acpxRecordId: string;
  acpxSessionId: string;
}

export interface SessionIdentityReadResult {
  identity: SessionIdentity | null;
  error: string;
}

// --- Route configuration ---

/** Default persistent session mode for agents that support Codex-style modes. */
const PERSISTENT_SESSION_MODE = "full-access";
const CLAUDE_BYPASS_MODE = "bypassPermissions";
const DEFAULT_PERMISSION_MODE: PermissionMode = "approve-all";
const ACPX_MAX_BUFFER = 50 * 1024 * 1024; // 50 MB

export interface FileCaptureRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Timeout in seconds */
  timeout?: number;
}

export interface FileCaptureRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command synchronously while streaming stdout/stderr to temp files.
 *
 * This avoids the `execFileSync` maxBuffer cap for large agent/tool output,
 * but still returns the captured text to the caller after the process exits.
 */
export function runCommandWithFileCapture(options: FileCaptureRunOptions): FileCaptureRunResult {
  const captureDir = mkdtempSync(join(tmpdir(), "acpx-capture-"));
  const stdoutPath = join(captureDir, "stdout.log");
  const stderrPath = join(captureDir, "stderr.log");
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;

  try {
    stdoutFd = openSync(stdoutPath, "w");
    stderrFd = openSync(stderrPath, "w");

    const result = spawnSync(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", stdoutFd, stderrFd],
      timeout: options.timeout ? options.timeout * 1000 : undefined,
    });

    closeSync(stdoutFd);
    stdoutFd = null;
    closeSync(stderrFd);
    stderrFd = null;

    let stderr = readFileSync(stderrPath, "utf8");
    const stdout = readFileSync(stdoutPath, "utf8");

    if (result.error) {
      const errorMessage = result.error.message || String(result.error);
      stderr = stderr ? `${stderr}\n${errorMessage}` : errorMessage;
    }

    return {
      exitCode:
        typeof result.status === "number"
          ? result.status
          : result.error || result.signal
            ? 1
            : 0,
      stdout,
      stderr,
    };
  } finally {
    if (stdoutFd !== null) {
      try {
        closeSync(stdoutFd);
      } catch {
        // Already closed.
      }
    }
    if (stderrFd !== null) {
      try {
        closeSync(stderrFd);
      } catch {
        // Already closed.
      }
    }
    rmSync(captureDir, { recursive: true, force: true });
  }
}

// --- Preflight ---

function commandExists(cmd: string): boolean {
  try {
    execFileSync("command", ["-v", cmd], { stdio: "pipe", shell: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies that required tools are available on the runner.
 */
export function preflight(): PreflightResult {
  const required = ["acpx", "gh", "git"];
  const missing = required.filter((cmd) => !commandExists(cmd));
  return { ok: missing.length === 0, missing };
}

// --- Session naming ---

/**
 * Converts a thread key into a safe acpx session name.
 * acpx session names should be short, filesystem-safe identifiers.
 */
export function sessionNameFromThreadKey(threadKey: string): string {
  // thread_key format: repo:target_kind:target_number:route:lane
  // session name: target_kind-target_number-route-lane
  const parts = threadKey.split(":");
  if (parts.length >= 5) {
    return parts.slice(1).join("-");
  }
  return threadKey.replace(/[/:]/g, "-");
}

export function buildAcpxArgs(options: {
  agent: string;
  prompt: string;
  permissionMode: PermissionMode;
  timeout?: number;
  sessionName?: string;
  isExecRoute: boolean;
}): string[] {
  const args: string[] = [];

  // acpx requires global flags before the agent token.
  args.push(`--${options.permissionMode}`);
  args.push("--format", "json", "--json-strict");
  args.push("--suppress-reads");
  if (options.timeout) {
    args.push("--timeout", String(options.timeout));
  }

  args.push(options.agent);

  if (options.isExecRoute || !options.sessionName) {
    args.push("exec");
  } else {
    args.push("prompt", "-s", options.sessionName);
  }

  args.push(options.prompt);
  return args;
}

export function parsePermissionModeOrSetDefault(value: string | undefined): PermissionMode {
  const v = value?.trim();
  if (v === "approve-all" || v === "approve-reads" || v === "deny-all") {
    return v;
  }
  return DEFAULT_PERMISSION_MODE;
}

export function selectPromptForSessionOutcome(options: {
  fullPrompt: string;
  continuationPrompt?: string;
  outcome: SessionEnsureOutcome;
}): string {
  if (options.outcome.kind === "resumed" && options.continuationPrompt) {
    return options.continuationPrompt;
  }
  return options.fullPrompt;
}

export interface SessionSetupCommand {
  label: string;
  args: string[];
}

export function buildSessionSetupCommands(options: {
  agent: string;
  sessionName?: string;
  thoughtLevel?: string;
  permissionMode?: PermissionMode;
}): SessionSetupCommand[] {
  if (!options.sessionName) {
    return [];
  }

  const normalizedAgent = options.agent.trim().toLowerCase();
  if (normalizedAgent === "claude") {
    if (options.permissionMode === "approve-all") {
      return [
        {
          label: "set-mode",
          args: [options.agent, "set-mode", "-s", options.sessionName, CLAUDE_BYPASS_MODE],
        },
      ];
    }
    return [];
  }

  const commands: SessionSetupCommand[] = [];
  const thoughtLevel = options.thoughtLevel?.trim();
  if (thoughtLevel) {
    commands.push({
      label: "set thought_level",
      args: [options.agent, "set", "-s", options.sessionName, "thought_level", thoughtLevel],
    });
  }

  commands.push({
    label: "set-mode",
    args: [options.agent, "set-mode", "-s", options.sessionName, PERSISTENT_SESSION_MODE],
  });

  return commands;
}

export function parseSessionIdentity(raw: string): SessionIdentity | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;

    const acpxRecordId =
      typeof data.acpxRecordId === "string"
        ? data.acpxRecordId
        : typeof data.recordId === "string"
          ? data.recordId
          : "";
    const acpxSessionId =
      typeof data.acpSessionId === "string"
        ? data.acpSessionId
        : typeof data.acpxSessionId === "string"
          ? data.acpxSessionId
          : typeof data.sessionId === "string"
            ? data.sessionId
            : "";

    if (!acpxRecordId || !acpxSessionId) {
      return null;
    }
    return { acpxRecordId, acpxSessionId };
  } catch {
    return null;
  }
}

/**
 * Ensures a named session exists via `acpx <agent> sessions ensure`.
 *
 * When `resumeSessionId` is provided, first attempts to resume that ACP
 * session. If resume fails (expired session, new runner, etc.), falls back
 * to creating a fresh session under the same name.
 *
 * Returns a structured outcome so the runtime can distinguish:
 * - resumed successfully
 * - resumed failed, fresh fallback used
 * - no resume attempted
 * - failed before the run
 */
function ensureSession(
  agent: string,
  sessionName: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  resumeSessionId?: string,
): SessionEnsureOutcome {
  if (resumeSessionId) {
    try {
      execFileSync(
        "acpx",
        [agent, "sessions", "ensure", "--name", sessionName, "--resume-session", resumeSessionId],
        {
          cwd,
          env,
          stdio: "pipe",
          maxBuffer: ACPX_MAX_BUFFER,
        },
      );
      return { kind: "resumed", resumedFromSessionId: resumeSessionId };
    } catch (err: unknown) {
      const resumeError = (err as { stderr?: Buffer })?.stderr?.toString("utf8") ?? String(err);
      try {
        execFileSync("acpx", [agent, "sessions", "ensure", "--name", sessionName], {
          cwd,
          env,
          stdio: "pipe",
          maxBuffer: ACPX_MAX_BUFFER,
        });
        return {
          kind: "resume_fallback",
          resumedFromSessionId: resumeSessionId,
          error: resumeError,
        };
      } catch (freshErr: unknown) {
        const freshError = (freshErr as { stderr?: Buffer })?.stderr?.toString("utf8") ?? String(freshErr);
        return {
          kind: "failed",
          resumedFromSessionId: resumeSessionId,
          error: `resume failed: ${resumeError}\nfresh ensure failed: ${freshError}`,
        };
      }
    }
  }

  try {
    execFileSync("acpx", [agent, "sessions", "ensure", "--name", sessionName], {
      cwd,
      env,
      stdio: "pipe",
      maxBuffer: ACPX_MAX_BUFFER,
    });
    return { kind: "fresh" };
  } catch (err: unknown) {
    const error = (err as { stderr?: Buffer })?.stderr?.toString("utf8") ?? String(err);
    return { kind: "failed", error };
  }
}

// --- NDJSON parsing ---

/**
 * Extracts the final assistant message from a compacted session log.
 * Returns the last `message` entry — reasoning traces are in the JSONL.
 */
export function extractAssistantText(compactedLog: string): string {
  let lastMessage = "";
  for (const line of compactedLog.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; text?: string };
      if (entry.type === "message" && entry.text) {
        lastMessage = entry.text;
      }
    } catch {
      // skip
    }
  }
  return lastMessage;
}

/**
 * Compacts raw acpx NDJSON into a clean session log.
 *
 * - Merges streaming `agent_message_chunk` tokens into one entry per turn
 * - Keeps tool_call events (with name/status)
 * - Keeps usage_update events
 * - Extracts session metadata from the verbose init/session payloads
 * - Drops everything else (protocol handshake, model lists, etc.)
 */
export function compactSessionLog(ndjson: string): string {
  const entries: string[] = [];
  let currentText = "";
  let sessionId = "";

  function flushText(): void {
    if (currentText) {
      entries.push(JSON.stringify({ type: "message", text: currentText }));
      currentText = "";
    }
  }

  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;

      // Extract sessionId from session/new response
      const result = event.result as Record<string, unknown> | undefined;
      if (result?.sessionId && !sessionId) {
        sessionId = String(result.sessionId);
        const models = result.models as Record<string, unknown> | undefined;
        entries.push(JSON.stringify({
          type: "session",
          sessionId,
          model: models?.currentModelId ?? null,
        }));
        continue;
      }

      const update = (event.params as Record<string, unknown> | undefined)
        ?.update as Record<string, unknown> | undefined;
      if (!update?.sessionUpdate) continue;

      const updateType = update.sessionUpdate;

      if (updateType === "agent_message_chunk") {
        const content = update.content as Record<string, unknown> | undefined;
        if (content?.type === "text" && content.text) {
          currentText += String(content.text);
        }
      } else if (updateType === "tool_call" || updateType === "tool_call_update") {
        flushText();
        entries.push(JSON.stringify({
          type: updateType,
          name: update.name ?? update.title ?? null,
          status: update.status ?? null,
        }));
      } else if (updateType === "usage_update") {
        flushText();
        entries.push(JSON.stringify({
          type: "usage",
          used: update.used ?? null,
          size: update.size ?? null,
        }));
      }
    } catch {
      // Preserve unparseable lines so schema drift doesn't silently vanish
      entries.push(JSON.stringify({ type: "parse_error", raw: line.slice(0, 500) }));
    }
  }
  flushText();

  // Append stop reason from final RPC response
  const lastLine = ndjson.trimEnd().split("\n").pop();
  if (lastLine) {
    try {
      const last = JSON.parse(lastLine) as Record<string, unknown>;
      const lastResult = last.result as Record<string, unknown> | undefined;
      if (lastResult?.stopReason) {
        entries.push(JSON.stringify({ type: "done", stopReason: lastResult.stopReason }));
      }
    } catch { /* skip */ }
  }

  return entries.join("\n") + "\n";
}

const SESSION_LOG_MAX_MESSAGE_CHARS = 2000;

/**
 * Formats a compacted session log for human-readable display in CI logs.
 * Message text is truncated to SESSION_LOG_MAX_MESSAGE_CHARS per entry.
 */
export function formatSessionLogForDisplay(sessionLog: string): string {
  const lines: string[] = [];
  for (const raw of sessionLog.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const entry = JSON.parse(raw) as Record<string, unknown>;
      switch (entry.type) {
        case "session":
          lines.push(`[session] ${entry.model ?? "unknown"} ${entry.sessionId ?? ""}`);
          break;
        case "message": {
          const text = String(entry.text || "");
          const display = text.length > SESSION_LOG_MAX_MESSAGE_CHARS
            ? text.slice(0, SESSION_LOG_MAX_MESSAGE_CHARS) + `... (${text.length} chars)`
            : text;
          lines.push(`[message] ${display}`);
          break;
        }
        case "tool_call":
          lines.push(`[tool]    ${entry.name ?? "unknown"} (${entry.status ?? "?"})`);
          break;
        case "tool_call_update":
          if (entry.status) {
            lines.push(`[tool]    ${entry.name ?? "  ↳"} (${entry.status})`);
          }
          break;
        case "usage":
          lines.push(`[usage]   ${entry.used ?? "?"} tokens`);
          break;
        case "done":
          lines.push(`[done]    ${entry.stopReason ?? "unknown"}`);
          break;
        case "parse_error":
          lines.push(`[warn]    unparseable line: ${String(entry.raw ?? "").slice(0, 200)}`);
          break;
        default:
          break;
      }
    } catch {
      // skip
    }
  }
  return lines.join("\n");
}

export function tailForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `[truncated ${value.length - maxChars} chars]\n${value.slice(-maxChars)}`;
}

// --- Runner ---

/**
 * Runs an acpx prompt and returns the result.
 *
 * CLI argv ordering: acpx [global-flags] <agent> <subcommand> [subcommand-args] [prompt]
 */
export function runAcpx(options: AcpxRunOptions): AcpxRunResult {
  const {
    agent,
    prompt,
    continuationPrompt,
    cwd,
    sessionMode,
    threadKey,
    timeout,
    thoughtLevel,
    resumeSessionId,
    env: extraEnv,
  } = options;

  const permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const isExecRoute = sessionMode === "exec";
  const env = { ...process.env, ...extraEnv };
  let sessionName: string | undefined;
  let sessionEnsureOutcome: SessionEnsureOutcome = { kind: "not_applicable" };
  if (isExecRoute || !threadKey) {
    sessionName = undefined;
  } else {
    // Persistent lane: ensure session exists first
    sessionName = sessionNameFromThreadKey(threadKey);
    sessionEnsureOutcome = ensureSession(agent, sessionName, cwd, env, resumeSessionId);
    if (sessionEnsureOutcome.kind === "failed") {
      return {
        exitCode: 1,
        stdout: "",
        rawStdout: "",
        stderr: `session setup failed: ${sessionEnsureOutcome.error}`,
        sessionLog: "",
        sessionName,
        sessionEnsureOutcome,
      };
    }
    try {
      for (const command of buildSessionSetupCommands({
        agent,
        sessionName,
        thoughtLevel,
        permissionMode,
      })) {
        execFileSync("acpx", command.args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: ACPX_MAX_BUFFER,
        });
      }
    } catch (err: unknown) {
      const error = err as { status?: number; stderr?: Buffer };
      const stderr = error.stderr?.toString("utf8") ?? String(err);
      return {
        exitCode: error.status ?? 1,
        stdout: "",
        rawStdout: "",
        stderr: `session setup failed: ${stderr}`,
        sessionLog: "",
        sessionName,
        sessionEnsureOutcome,
      };
    }
  }
  const args = buildAcpxArgs({
    agent,
    prompt: selectPromptForSessionOutcome({
      fullPrompt: prompt,
      continuationPrompt,
      outcome: sessionEnsureOutcome,
    }),
    permissionMode,
    timeout,
    sessionName,
    isExecRoute,
  });

  const result = runCommandWithFileCapture({
    command: "acpx",
    args,
    cwd,
    env,
    timeout,
  });

  const sessionLog = compactSessionLog(result.stdout);
  const stdout = extractAssistantText(sessionLog);
  return {
    exitCode: result.exitCode,
    stdout,
    rawStdout: result.stdout,
    stderr: result.stderr,
    sessionLog,
    sessionName,
    sessionEnsureOutcome,
  };
}

/**
 * Reads session metadata after a run to extract identity fields.
 * Returns acpxRecordId and acpxSessionId if available.
 */
export function readSessionIdentityResult(
  agent: string,
  sessionName: string,
  cwd: string,
): SessionIdentityReadResult {
  try {
    const result = runCommandWithFileCapture({
      command: "acpx",
      args: ["--format", "json", agent, "sessions", "show", sessionName],
      cwd,
    });

    if (result.exitCode !== 0) {
      return {
        identity: null,
        error: result.stderr.trim() || `acpx sessions show exited with code ${result.exitCode}`,
      };
    }

    const identity = parseSessionIdentity(result.stdout);
    if (!identity) {
      return {
        identity: null,
        error: "acpx session metadata did not include acpxRecordId and acpxSessionId",
      };
    }
    return { identity, error: "" };
  } catch (err: unknown) {
    return { identity: null, error: err instanceof Error ? err.message : String(err) };
  }
}
