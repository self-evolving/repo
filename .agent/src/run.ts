// Agent adapter entrypoint.
//
// Reads a RuntimeEnvelope from environment variables, validates it, renders
// the prompt template (base + route), runs acpx directly, and outputs the
// result.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  type RuntimeEnvelope,
  buildEnvelope,
  validateEnvelope,
  envelopeToPromptVars,
} from "./envelope.js";
import {
  preflight,
  runAcpx,
  readSessionIdentityResult,
  formatSessionLogForDisplay,
  tailForLog,
  parsePermissionModeOrSetDefault,
} from "./acpx-adapter.js";
import {
  type ThreadState,
  type PushOptions,
  getThreadState,
  markThreadRunning,
  markThreadCompleted,
  markThreadFailed,
} from "./thread-state.js";
import {
  type SessionPolicy,
  parseSessionPolicy,
  sessionModeForPolicy,
  tracksThreadState,
} from "./session-policy.js";
import {
  buildRunningThreadStateFields,
  buildThreadStateFieldsFromEnsureOutcome,
  buildCompletedThreadStateUpdates,
  buildFailedThreadStateUpdates,
  resumeSessionIdFromForkSource,
  resumeSessionIdFromState,
  shouldUseContinuationPrompt,
  shouldFailRunBecauseOfEnsureOutcome,
  shouldFailRunBecauseOfThreadStateError,
  shouldFailBecauseRequiredResumeIdentityMissing,
} from "./runtime-state.js";
import { configureBotIdentity } from "./git.js";
import { setOutput } from "./output.js";

// --- Logging ---

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

const SUPPLEMENTAL_PROMPT_VAR_NAMES = [
  "MEMORY_AVAILABLE",
  "MEMORY_DIR",
  "MEMORY_REF",
  "RUBRICS_AVAILABLE",
  "RUBRICS_DIR",
  "RUBRICS_REF",
  "RUBRICS_CONTEXT_FILE",
  "REQUEST_COMMENT_ID",
  "REQUEST_COMMENT_URL",
  "REQUEST_SOURCE_KIND",
  "REVIEWS_DIR",
  "CLAUDE_REVIEW_FILE",
  "CODEX_REVIEW_FILE",
  "ORCHESTRATOR_SOURCE_ACTION",
  "ORCHESTRATOR_SOURCE_CONCLUSION",
  "ORCHESTRATOR_SOURCE_RUN_ID",
  "ORCHESTRATOR_NEXT_TARGET_NUMBER",
  "ORCHESTRATOR_CONTEXT",
  "ORCHESTRATOR_CURRENT_ROUND",
  "ORCHESTRATOR_MAX_ROUNDS",
] as const;

// --- Envelope from env ---

function envelopeFromEnv(): RuntimeEnvelope {
  return buildEnvelope({
    repo_slug: process.env.REPO_SLUG || "",
    route: process.env.ROUTE || "",
    source_kind: process.env.SOURCE_KIND || "",
    target_kind: process.env.TARGET_KIND || "",
    target_number: Number(process.env.TARGET_NUMBER) || 0,
    target_url: process.env.TARGET_URL || "",
    request_text: process.env.REQUEST_TEXT || process.env.MENTION_BODY || "",
    requested_by: process.env.REQUESTED_BY || "",
    approval_comment_url: process.env.APPROVAL_COMMENT_URL || null,
    workflow: process.env.WORKFLOW || "",
    lane: process.env.LANE || "",
  });
}

// --- Prompt rendering ---

const BASE_PROMPT_PATH = ".github/prompts/_base.md";
const MEMORY_PROMPT_PATH = ".github/prompts/_memory.md";
const RUBRICS_PROMPT_PATH = ".github/prompts/_rubrics.md";

const PROMPT_TEMPLATES: Record<string, string> = {
  implement: ".github/prompts/agent-implement.md",
  review: ".github/prompts/review.md",
  "review-synthesize": ".github/prompts/review-synthesize.md",
  "review-synthesize-finalize": ".github/prompts/review-synthesize-finalize.md",
  "fix-pr": ".github/prompts/agent-fix-pr.md",
  answer: ".github/prompts/agent-answer.md",
  "create-action": ".github/prompts/agent-create-action.md",
  dispatch: ".github/prompts/agent-dispatch.md",
  "rubrics-review": ".github/prompts/rubrics-review.md",
  "rubrics-initialization": ".github/prompts/rubrics-initialization.md",
  "rubrics-update": ".github/prompts/rubrics-update.md",
  orchestrator: ".github/prompts/agent-orchestrator.md",
};

/**
 * Resolves the prompt template path from multiple sources:
 * 1. PROMPT_NAME env var → look up in PROMPT_TEMPLATES or .github/prompts/<name>.md
 * 2. SKILL_NAME env var → .skills/<name>/SKILL.md
 * 3. Fall back to route-based lookup in PROMPT_TEMPLATES
 */
function resolveTemplatePath(route: string, repoRoot: string): string | null {
  const promptName = process.env.PROMPT_NAME?.trim();
  const skillName = process.env.SKILL_NAME?.trim();

  if (promptName) {
    // Named prompt: check PROMPT_TEMPLATES first, then .github/prompts/<name>.md
    if (PROMPT_TEMPLATES[promptName]) {
      const p = join(repoRoot, PROMPT_TEMPLATES[promptName]);
      if (existsSync(p)) return p;
    }
    const p = join(repoRoot, ".github", "prompts", `${promptName}.md`);
    if (existsSync(p)) return p;
    return null;
  }

  if (skillName) {
    // Named skill: .skills/<name>/SKILL.md
    const p = join(repoRoot, ".skills", skillName, "SKILL.md");
    if (existsSync(p)) return p;
    return null;
  }

  // Default: route-based lookup
  const relPath = PROMPT_TEMPLATES[route];
  if (!relPath) return null;
  const p = join(repoRoot, relPath);
  if (existsSync(p)) return p;
  return null;
}

function renderPrompt(
  templatePath: string,
  vars: Record<string, string>,
  repoRoot: string,
): string {
  const basePath = join(repoRoot, BASE_PROMPT_PATH);
  const memoryPath = join(repoRoot, MEMORY_PROMPT_PATH);
  const rubricsPath = join(repoRoot, RUBRICS_PROMPT_PATH);
  let base = "";
  if (existsSync(basePath)) {
    base = readFileSync(basePath, "utf8") + "\n\n";
  }
  let memory = "";
  if (vars.MEMORY_AVAILABLE === "true" && existsSync(memoryPath)) {
    memory = readFileSync(memoryPath, "utf8") + "\n\n";
  }
  let rubrics = "";
  if (vars.RUBRICS_AVAILABLE === "true" && existsSync(rubricsPath)) {
    rubrics = readFileSync(rubricsPath, "utf8") + "\n\n";
  }
  const template = readFileSync(templatePath, "utf8");
  const combined = base + memory + rubrics + template;
  return combined.replace(/\$\{(\w+)\}/g, (_match, key) => vars[key] ?? "");
}

// --- Helpers ---

const FAILURE_OUTPUT_TAIL_CHARS = 4000;

function sessionPolicyFromEnv(): SessionPolicy {
  const parsed = parseSessionPolicy(process.env.SESSION_POLICY);
  if (!parsed) {
    throw new Error(
      "Missing or invalid SESSION_POLICY (expected one of: none, track-only, resume-best-effort, resume-required)",
    );
  }
  return parsed;
}

function buildThreadStateOptions(envelope: RuntimeEnvelope): PushOptions {
  const opts: PushOptions = { repo: envelope.repo_slug };
  if (process.env.INPUT_GITHUB_TOKEN) {
    opts.token = process.env.INPUT_GITHUB_TOKEN;
  }
  return opts;
}

function currentRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!server || !repo || !runId) {
    return "";
  }
  return `${server}/${repo}/actions/runs/${runId}`;
}

function persistFailureOutputFile(
  runnerTemp: string,
  fileId: string,
  suffix: string,
  content: string,
): string {
  const path = join(runnerTemp, `acpx-${suffix}-${fileId}.log`);
  writeFileSync(path, content, "utf8");
  return path;
}

function persistFailureOutputs(
  runnerTemp: string,
  fileId: string,
  rawStdout: string,
  rawStderr: string,
): { rawStdoutFile: string; rawStderrFile: string } {
  let rawStdoutFile = "";
  let rawStderrFile = "";

  if (rawStdout) {
    rawStdoutFile = persistFailureOutputFile(runnerTemp, fileId, "stdout", rawStdout);
    setOutput("raw_stdout_file", rawStdoutFile);
  }
  if (rawStderr) {
    rawStderrFile = persistFailureOutputFile(runnerTemp, fileId, "stderr", rawStderr);
    setOutput("raw_stderr_file", rawStderrFile);
  }

  return { rawStdoutFile, rawStderrFile };
}

function buildSharedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.INPUT_GITHUB_TOKEN) {
    env.GH_TOKEN = process.env.INPUT_GITHUB_TOKEN;
    env.GITHUB_TOKEN = process.env.INPUT_GITHUB_TOKEN;
  }
  if (process.env.INPUT_OPENAI_API_KEY) {
    env.OPENAI_API_KEY = process.env.INPUT_OPENAI_API_KEY;
  }
  if (process.env.MODEL_REASONING_EFFORT) {
    env.MODEL_REASONING_EFFORT = process.env.MODEL_REASONING_EFFORT;
    // Claude Code reads effort from this env var directly, so both the
    // flow path and the direct path pick it up without session setup.
    env.CLAUDE_CODE_EFFORT_LEVEL = process.env.MODEL_REASONING_EFFORT;
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return env;
}

// --- Main ---

function main(): void {
  const repoRoot = process.env.GITHUB_WORKSPACE || resolve(".");
  const agent = process.env.ACPX_AGENT;
  if (!agent) {
    log("error", "Missing required ACPX_AGENT");
    process.exitCode = 2;
    return;
  }

  // 1. Parse envelope
  const envelope: RuntimeEnvelope = envelopeFromEnv();
  const errors: string[] = validateEnvelope(envelope);

  if (errors.length > 0) {
    log("error", "Envelope validation failed", { errors });
    process.exitCode = 2;
    return;
  }

  log("info", "Envelope parsed", {
    route: envelope.route,
    target: `${envelope.target_kind}#${envelope.target_number}`,
    thread_key: envelope.thread_key,
  });

  // 2. Resolve prompt template
  const templatePath = resolveTemplatePath(envelope.route, repoRoot);
  if (!templatePath) {
    const source = process.env.PROMPT_NAME || process.env.SKILL_NAME || envelope.route;
    log("error", `No prompt template found for: ${source}`);
    process.exitCode = 2;
    return;
  }

  // 3. Render prompt (base + route template)
  const promptVars: Record<string, string> = envelopeToPromptVars(envelope);

  // Supplemental prompt vars from env (route-specific, not part of RuntimeEnvelope).
  // Keep this contract explicit so workflows cannot inject arbitrary prompt
  // variables without updating the runtime allowlist here.
  for (const name of SUPPLEMENTAL_PROMPT_VAR_NAMES) {
    if (process.env[name]) promptVars[name] = process.env[name]!;
  }
  if (promptVars.RUBRICS_CONTEXT_FILE && existsSync(promptVars.RUBRICS_CONTEXT_FILE)) {
    promptVars.RUBRICS_CONTEXT = readFileSync(promptVars.RUBRICS_CONTEXT_FILE, "utf8");
  }
  // Aliases for backward compat
  promptVars.PR_NUMBER = promptVars.TARGET_NUMBER;
  promptVars.GITHUB_REPOSITORY = promptVars.REPO_SLUG;

  const prompt = renderPrompt(templatePath, promptVars, repoRoot);
  const continuationPrompt = [
    "Trigger metadata:",
    `- Triggering source kind: \`${promptVars.REQUEST_SOURCE_KIND || ""}\``,
    `- Triggering comment/review ID: \`${promptVars.REQUEST_COMMENT_ID || ""}\``,
    `- Triggering comment/review URL: \`${promptVars.REQUEST_COMMENT_URL || ""}\``,
    "",
    promptVars.REQUEST_TEXT,
  ].join("\n");

  log("info", "Prompt rendered", {
    template: templatePath,
    prompt_length: prompt.length,
    continuation_prompt_length: continuationPrompt.length,
  });

  // 4. Preflight
  const check = preflight();
  if (!check.ok) {
    log("error", "Preflight failed: missing tools", { missing: check.missing });
    process.exitCode = 2;
    return;
  }

  // 5. Common setup
  setOutput("prompt", prompt);
  setOutput("thread_key", envelope.thread_key);
  setOutput("envelope_route", envelope.route);
  setOutput("raw_stdout_file", "");
  setOutput("raw_stderr_file", "");
  setOutput("resume_status", "not_attempted");
  setOutput("last_resume_error", "");
  setOutput(
    "session_bundle_restore_status",
    process.env.SESSION_BUNDLE_RESTORE_STATUS || "not_attempted",
  );
  setOutput(
    "session_bundle_restore_error",
    process.env.SESSION_BUNDLE_RESTORE_ERROR || "",
  );
  setOutput("session_fork_from_thread_key", process.env.SESSION_FORK_FROM_THREAD_KEY || "");
  setOutput("session_fork_restore_status", process.env.SESSION_FORK_RESTORE_STATUS || "not_attempted");
  setOutput("session_fork_restore_error", process.env.SESSION_FORK_RESTORE_ERROR || "");

  const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
  const fileId = randomBytes(8).toString("hex");
  const sharedEnv = buildSharedEnv();
  const permissionMode = parsePermissionModeOrSetDefault(process.env.ACPX_PERMISSION_MODE);
  runDirectPath({
    agent, repoRoot, prompt, continuationPrompt, envelope, permissionMode,
    sharedEnv, runnerTemp, fileId,
  });
}

// --- Direct acpx execution path ---

function runDirectPath(opts: {
  agent: string;
  repoRoot: string;
  prompt: string;
  continuationPrompt: string;
  envelope: RuntimeEnvelope;
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  sharedEnv: Record<string, string>;
  runnerTemp: string;
  fileId: string;
}): void {
  const {
    agent,
    repoRoot,
    prompt,
    continuationPrompt,
    envelope,
    permissionMode,
    sharedEnv,
    runnerTemp,
    fileId,
  } = opts;
  let sessionPolicy: SessionPolicy;
  try {
    sessionPolicy = sessionPolicyFromEnv();
  } catch (err) {
    log("error", String(err), { route: envelope.route });
    process.exitCode = 2;
    return;
  }
  const trackThreadState = tracksThreadState(sessionPolicy) && Boolean(envelope.thread_key);
  const threadStateOpts = buildThreadStateOptions(envelope);

  let threadState: ThreadState | null = null;
  let existingThreadState: ThreadState | null = null;
  let resumeSessionId: string | undefined;
  let forkResumeSessionId: string | undefined;
  let continuationPromptAllowed = false;
  const forkFromThreadKey = String(process.env.SESSION_FORK_FROM_THREAD_KEY || "").trim();
  const forkAcpxSessionId = String(process.env.SESSION_FORK_ACPX_SESSION_ID || "").trim();

  if (trackThreadState) {
    try {
      configureBotIdentity(repoRoot);
      existingThreadState = getThreadState(envelope.thread_key, repoRoot, threadStateOpts);
      resumeSessionId = resumeSessionIdFromState(sessionPolicy, existingThreadState);
      continuationPromptAllowed = shouldUseContinuationPrompt(existingThreadState, resumeSessionId);
      forkResumeSessionId = resumeSessionIdFromForkSource(
        sessionPolicy,
        existingThreadState,
        forkAcpxSessionId,
      );
      if (!resumeSessionId && forkResumeSessionId) {
        resumeSessionId = forkResumeSessionId;
        continuationPromptAllowed = false;
        log("info", "Using fork source session as resume seed", {
          thread_key: envelope.thread_key,
          forked_from_thread_key: forkFromThreadKey,
          forked_from_acpx_session_id: forkAcpxSessionId,
        });
      }

      if (existingThreadState) {
        log("info", "Found existing thread state", {
          thread_key: envelope.thread_key,
          prior_status: existingThreadState.status,
          prior_resume_status: existingThreadState.resume_status,
          prior_attempt: existingThreadState.attempt_count,
          session_policy: sessionPolicy,
          resume_session_id: resumeSessionId ?? null,
        });
      }

      threadState = markThreadRunning(
        envelope.thread_key,
        repoRoot,
        {
          last_run_url: currentRunUrl(),
          ...buildRunningThreadStateFields(),
          ...(forkResumeSessionId
            ? {
                forked_from_thread_key: forkFromThreadKey,
                forked_from_acpx_session_id: forkAcpxSessionId,
                bundle_restore_status: "restored_from_fork" as const,
                last_bundle_restore_error: "",
              }
            : {}),
        },
        threadStateOpts,
      );
      log("info", "Thread state marked running", {
        thread_key: envelope.thread_key,
        attempt: threadState.attempt_count,
        session_policy: sessionPolicy,
      });

      if (shouldFailBecauseRequiredResumeIdentityMissing(sessionPolicy, existingThreadState, resumeSessionId)) {
        const missingResumeError = "resume-required route has prior thread state but no acpxSessionId to resume";
        setOutput("resume_status", "failed");
        setOutput("last_resume_error", missingResumeError);
        const failedUpdates = buildFailedThreadStateUpdates({
          kind: "failed",
          error: missingResumeError,
        });
        markThreadFailed(envelope.thread_key, threadState, repoRoot, failedUpdates, threadStateOpts);
        log("error", "Session continuity requirement not satisfied: prior thread state exists without resumable session identity", {
          thread_key: envelope.thread_key,
          session_policy: sessionPolicy,
        });
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      if (shouldFailRunBecauseOfThreadStateError(sessionPolicy)) {
        log("error", "Failed to update thread state (pre-run)", {
          error: String(err),
          session_policy: sessionPolicy,
        });
        process.exitCode = 1;
        return;
      }
      log("warn", "Failed to update thread state (pre-run)", {
        error: String(err),
        session_policy: sessionPolicy,
      });
    }
  }

  log("info", "Running acpx", { agent, route: envelope.route, permission_mode: permissionMode });

  const result = runAcpx({
    agent,
    prompt,
    cwd: repoRoot,
    sessionMode: sessionModeForPolicy(sessionPolicy),
    threadKey: envelope.thread_key,
    permissionMode,
    thoughtLevel: process.env.MODEL_REASONING_EFFORT,
    resumeSessionId,
    continuationPrompt: continuationPromptAllowed ? continuationPrompt : undefined,
    env: sharedEnv,
  });

  const resumeFields = buildThreadStateFieldsFromEnsureOutcome(result.sessionEnsureOutcome);
  setOutput("resume_status", resumeFields.resume_status);
  setOutput("last_resume_error", resumeFields.last_resume_error);

  log("info", "acpx completed", {
    exit_code: result.exitCode,
    session_name: result.sessionName,
    stdout_length: result.stdout.length,
    raw_stdout_length: result.rawStdout.length,
    stderr_length: result.stderr.length,
    session_log_length: result.sessionLog.length,
    session_ensure_outcome: result.sessionEnsureOutcome.kind,
  });

  // Display session activity in CI logs
  process.stderr.write("\n--- acpx session log ---\n");
  process.stderr.write(formatSessionLogForDisplay(result.sessionLog) + "\n");
  process.stderr.write("--- end session log ---\n\n");

  // Save session log
  const sessionLogFile = join(runnerTemp, `acpx-session-${fileId}.jsonl`);
  writeFileSync(sessionLogFile, result.sessionLog, "utf8");
  setOutput("session_log_file", sessionLogFile);
  log("info", "Session log saved", { session_log_file: sessionLogFile });

  // Save response
  const responseFile = join(runnerTemp, `acpx-response-${fileId}.md`);
  writeFileSync(responseFile, result.stdout, "utf8");
  setOutput("response_file", responseFile);

  let identity: { acpxRecordId: string; acpxSessionId: string } | null = null;
  if (result.sessionName) {
    setOutput("session_name", result.sessionName);
    const identityResult = readSessionIdentityResult(agent, result.sessionName, repoRoot);
    identity = identityResult.identity;
    if (identity) {
      setOutput("acpx_record_id", identity.acpxRecordId);
      setOutput("acpx_session_id", identity.acpxSessionId);
      log("info", "Session identity", {
        acpx_record_id: identity.acpxRecordId,
        acpx_session_id: identity.acpxSessionId,
      });
    } else {
      log("warn", "Session identity could not be read", {
        session_name: result.sessionName,
        error: identityResult.error,
      });
    }
  }

  if (trackThreadState && threadState) {
    try {
      if (result.exitCode !== 0) {
        const failedUpdates = buildFailedThreadStateUpdates(result.sessionEnsureOutcome);
        markThreadFailed(
          envelope.thread_key,
          threadState,
          repoRoot,
          failedUpdates,
          threadStateOpts,
        );
        log("info", "Thread state marked failed", {
          thread_key: envelope.thread_key,
          resume_status: failedUpdates.resume_status,
        });
      } else {
        const updates = buildCompletedThreadStateUpdates({
          outcome: result.sessionEnsureOutcome,
          identity: identity ?? null,
        });
        markThreadCompleted(envelope.thread_key, threadState, repoRoot, updates, threadStateOpts);
        log("info", "Thread state marked completed", {
          thread_key: envelope.thread_key,
          resume_status: updates.resume_status,
        });
      }
    } catch (err) {
      if (shouldFailRunBecauseOfThreadStateError(sessionPolicy)) {
        log("error", "Failed to update thread state (post-run)", {
          error: String(err),
          session_policy: sessionPolicy,
        });
        process.exitCode = 1;
      } else {
        log("warn", "Failed to update thread state (post-run)", {
          error: String(err),
          session_policy: sessionPolicy,
        });
      }
    }
  }

  if (shouldFailRunBecauseOfEnsureOutcome(sessionPolicy, result.sessionEnsureOutcome)) {
    log("error", "Session continuity requirement not satisfied", {
      thread_key: envelope.thread_key,
      session_policy: sessionPolicy,
      outcome: result.sessionEnsureOutcome,
      prior_session_id: existingThreadState?.acpxSessionId || null,
    });
    process.exitCode = 1;
  }

  if (result.exitCode !== 0) {
    const { rawStdoutFile, rawStderrFile } = persistFailureOutputs(
      runnerTemp,
      fileId,
      result.rawStdout,
      result.stderr,
    );
    log("error", "acpx run failed", {
      raw_stdout_file: rawStdoutFile || undefined,
      raw_stderr_file: rawStderrFile || undefined,
      raw_stdout_tail: tailForLog(result.rawStdout, FAILURE_OUTPUT_TAIL_CHARS),
      stderr_tail: tailForLog(result.stderr, FAILURE_OUTPUT_TAIL_CHARS),
    });
    process.exitCode = 1;
  }
}

main();
