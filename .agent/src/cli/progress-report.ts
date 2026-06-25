import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";

import { createIssueComment, updateIssueComment } from "../github.js";
import {
  buildProgressViewModel,
  renderFinal,
  renderRunning,
} from "../progress-render.js";
import {
  type AuthorizedCancelReaction,
  findAuthorizedCancelReaction,
  listCommentReactions,
} from "../reactions.js";

export type ProgressTargetKind = "issue" | "pull_request";

export interface ProgressReporterConfig {
  streamFile: string;
  repo: string;
  targetKind: ProgressTargetKind;
  targetNumber: number;
  requester: string;
  requesterAssociation?: string;
  route?: string;
  runId: string;
  pollIntervalMs: number;
  cancelEnabled: boolean;
  maxStreamBytes: number;
}

export interface ProgressReporterState {
  commentId: string;
  lastBody: string;
  lastStreamText: string;
  startTimeMs: number;
  cancelInvoked: boolean;
  finalized: boolean;
  stopped: boolean;
}

export interface ProgressReporterDeps {
  now: () => number;
  readStream: (path: string, maxBytes: number) => string;
  createComment: (repo: string, issueNumber: number, body: string) => string;
  updateComment: (repo: string, commentId: string, body: string) => void;
  listReactions: (repo: string, commentId: string) => ReturnType<typeof listCommentReactions>;
  findAuthorizedCancel: (
    repo: string,
    reactions: ReturnType<typeof listCommentReactions>,
    requester: string,
  ) => AuthorizedCancelReaction | null;
  invokeCancel: (reaction: AuthorizedCancelReaction, state: ProgressReporterState) => void;
  log: (message: string) => void;
}

export interface ProgressReporterTickResult {
  shouldContinue: boolean;
  created: boolean;
  patched: boolean;
  finalized: boolean;
  cancelInvoked: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_STREAM_BYTES = 1024 * 1024;
const MIN_POLL_INTERVAL_MS = 5_000;

export function createProgressReporterState(startTimeMs = Date.now()): ProgressReporterState {
  return {
    commentId: "",
    lastBody: "",
    lastStreamText: "",
    startTimeMs,
    cancelInvoked: false,
    finalized: false,
    stopped: false,
  };
}

export function progressReporterTick(
  config: ProgressReporterConfig,
  state: ProgressReporterState,
  deps: ProgressReporterDeps,
): ProgressReporterTickResult {
  const result: ProgressReporterTickResult = {
    shouldContinue: !state.stopped && !state.finalized,
    created: false,
    patched: false,
    finalized: false,
    cancelInvoked: false,
  };

  if (!result.shouldContinue) {
    return result;
  }

  const streamText = readStreamBestEffort(config, state, deps);
  const rendered = renderRunningBestEffort(config, state, deps, streamText);
  if (!rendered) {
    return result;
  }
  const { model, body: runningBody } = rendered;

  if (!state.commentId) {
    try {
      state.commentId = deps.createComment(config.repo, config.targetNumber, runningBody).trim();
      if (!state.commentId) {
        throw new Error("GitHub returned an empty progress comment id");
      }
      state.lastBody = runningBody;
      result.created = true;
    } catch (err: unknown) {
      deps.log(`Could not create progress comment: ${errorMessage(err)}`);
      state.stopped = true;
      result.shouldContinue = false;
      return result;
    }
  }

  if (model.stopReason) {
    result.patched = finalizeProgressReporter(config, state, deps, streamText) || result.patched;
    result.finalized = true;
    result.shouldContinue = false;
    return result;
  }

  if (runningBody !== state.lastBody) {
    try {
      deps.updateComment(config.repo, state.commentId, runningBody);
      state.lastBody = runningBody;
      result.patched = true;
    } catch (err: unknown) {
      deps.log(`Could not update progress comment: ${errorMessage(err)}`);
    }
  }

  if (config.cancelEnabled && !state.cancelInvoked) {
    const cancelReaction = findCancelReactionBestEffort(config, state, deps);
    if (cancelReaction) {
      state.cancelInvoked = true;
      result.cancelInvoked = true;
      try {
        deps.invokeCancel(cancelReaction, state);
      } catch (err: unknown) {
        deps.log(`Could not invoke progress cancellation: ${errorMessage(err)}`);
      }
    }
  }

  return result;
}

export function finalizeProgressReporter(
  config: ProgressReporterConfig,
  state: ProgressReporterState,
  deps: ProgressReporterDeps,
  streamText = readStreamBestEffort(config, state, deps),
): boolean {
  if (!state.commentId || state.finalized) {
    state.finalized = true;
    state.stopped = true;
    return false;
  }

  const finalBody = renderFinalBestEffort(config, state, deps, streamText);
  if (!finalBody) {
    state.finalized = true;
    state.stopped = true;
    return false;
  }
  let patched = false;

  if (finalBody !== state.lastBody) {
    try {
      deps.updateComment(config.repo, state.commentId, finalBody);
      state.lastBody = finalBody;
      patched = true;
    } catch (err: unknown) {
      deps.log(`Could not finalize progress comment: ${errorMessage(err)}`);
    }
  }

  state.finalized = true;
  state.stopped = true;
  return patched;
}

export function parseProgressReporterConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProgressReporterConfig | null {
  const streamFile = firstEnv(env, "AGENT_PROGRESS_STREAM_FILE", "PROGRESS_STREAM_FILE");
  const repo = firstEnv(env, "AGENT_PROGRESS_REPO", "REPO_SLUG", "GITHUB_REPOSITORY");
  const targetKind = normalizeTargetKind(firstEnv(env, "AGENT_PROGRESS_TARGET_KIND", "TARGET_KIND"));
  const targetNumber = parsePositiveInteger(firstEnv(env, "AGENT_PROGRESS_TARGET_NUMBER", "TARGET_NUMBER"));

  if (!streamFile || !repo || !targetKind || !targetNumber) {
    return null;
  }

  return {
    streamFile,
    repo,
    targetKind,
    targetNumber,
    requester: firstEnv(env, "AGENT_PROGRESS_REQUESTER", "REQUESTED_BY", "GITHUB_ACTOR"),
    requesterAssociation: firstEnv(env, "AGENT_PROGRESS_REQUESTER_ASSOCIATION", "REQUESTER_ASSOCIATION"),
    route: firstEnv(env, "AGENT_PROGRESS_ROUTE", "ROUTE"),
    runId: firstEnv(env, "AGENT_PROGRESS_RUN_ID", "GITHUB_RUN_ID") || "unknown",
    pollIntervalMs: parseDurationMs(
      firstEnv(env, "AGENT_PROGRESS_POLL_INTERVAL_MS", "PROGRESS_POLL_INTERVAL_MS"),
      DEFAULT_POLL_INTERVAL_MS,
    ),
    cancelEnabled: parseBoolean(firstEnv(env, "AGENT_PROGRESS_CANCEL_ENABLED", "PROGRESS_CANCEL_ENABLED")),
    maxStreamBytes: parseDurationMs(
      firstEnv(env, "AGENT_PROGRESS_MAX_STREAM_BYTES", "PROGRESS_MAX_STREAM_BYTES"),
      DEFAULT_MAX_STREAM_BYTES,
      1,
    ),
  };
}

export function defaultProgressReporterDeps(): ProgressReporterDeps {
  return {
    now: () => Date.now(),
    readStream: readStreamTail,
    createComment: createIssueComment,
    updateComment: updateIssueComment,
    listReactions: listCommentReactions,
    findAuthorizedCancel: findAuthorizedCancelReaction,
    invokeCancel: (reaction) => {
      console.log(`Authorized progress cancellation requested by @${reaction.user}.`);
    },
    log: (message) => console.warn(message),
  };
}

export function runProgressReporter(
  config: ProgressReporterConfig,
  deps: ProgressReporterDeps = defaultProgressReporterDeps(),
): void {
  const state = createProgressReporterState(deps.now());
  let timer: NodeJS.Timeout | undefined;

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const runTick = (): void => {
    const result = progressReporterTick(config, state, deps);
    if (!result.shouldContinue) {
      stop();
      process.exitCode = 0;
    }
  };

  const finalizeAndStop = (): void => {
    stop();
    finalizeProgressReporter(config, state, deps);
    process.exit(0);
  };

  process.once("SIGTERM", finalizeAndStop);
  process.once("SIGINT", finalizeAndStop);

  runTick();
  if (!state.stopped && !state.finalized) {
    timer = setInterval(runTick, config.pollIntervalMs);
  }
}

export function readStreamTail(path: string, maxBytes = DEFAULT_MAX_STREAM_BYTES): string {
  if (!path || !existsSync(path)) return "";

  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const bytesToRead = Math.min(Math.max(0, maxBytes), size);
    if (bytesToRead === 0) return "";

    const buffer = Buffer.alloc(bytesToRead);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, bytesToRead, size - bytesToRead);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort only.
      }
    }
  }
}

function readStreamBestEffort(
  config: ProgressReporterConfig,
  state: ProgressReporterState,
  deps: ProgressReporterDeps,
): string {
  try {
    const next = deps.readStream(config.streamFile, config.maxStreamBytes);
    state.lastStreamText = next;
    return next;
  } catch (err: unknown) {
    deps.log(`Could not read progress stream: ${errorMessage(err)}`);
    return state.lastStreamText;
  }
}

function findCancelReactionBestEffort(
  config: ProgressReporterConfig,
  state: ProgressReporterState,
  deps: ProgressReporterDeps,
): AuthorizedCancelReaction | null {
  try {
    const reactions = deps.listReactions(config.repo, state.commentId);
    return deps.findAuthorizedCancel(config.repo, reactions, config.requester);
  } catch (err: unknown) {
    deps.log(`Could not inspect progress reactions: ${errorMessage(err)}`);
    return null;
  }
}

function renderRunningBestEffort(
  config: ProgressReporterConfig,
  state: ProgressReporterState,
  deps: ProgressReporterDeps,
  streamText: string,
): { model: ReturnType<typeof buildProgressViewModel>; body: string } | null {
  try {
    const model = buildProgressViewModel(streamText, {
      runId: config.runId,
      route: config.route,
      elapsedMs: deps.now() - state.startTimeMs,
    });
    return { model, body: renderRunning(model) };
  } catch (err: unknown) {
    deps.log(`Could not render progress comment: ${errorMessage(err)}`);
    return null;
  }
}

function renderFinalBestEffort(
  config: ProgressReporterConfig,
  state: ProgressReporterState,
  deps: ProgressReporterDeps,
  streamText: string,
): string | null {
  try {
    const model = buildProgressViewModel(streamText, {
      runId: config.runId,
      route: config.route,
      status: "finalized",
      elapsedMs: deps.now() - state.startTimeMs,
    });
    return renderFinal(model, "finished");
  } catch (err: unknown) {
    deps.log(`Could not render final progress comment: ${errorMessage(err)}`);
    return null;
  }
}

function firstEnv(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function normalizeTargetKind(value: string): ProgressTargetKind | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "issue") return "issue";
  if (normalized === "pull_request" || normalized === "pr") return "pull_request";
  return null;
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseDurationMs(value: string, fallback: number, minimum = MIN_POLL_INTERVAL_MS): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value: string): boolean {
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (require.main === module) {
  const config = parseProgressReporterConfig();
  if (!config) {
    console.log("Progress reporter configuration incomplete; skipping.");
  } else {
    runProgressReporter(config);
  }
}
