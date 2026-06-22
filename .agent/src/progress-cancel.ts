import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RunStatus } from "./response.js";

export const PROGRESS_CANCEL_MARKER_FILENAME = "agent-progress-cancelled";

export interface ReconciledProgressStatus {
  status: RunStatus;
  cancelled: boolean;
  cancelledBy: string;
}

export function defaultProgressCancelMarkerFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = firstEnv(
    env,
    "AGENT_PROGRESS_CANCEL_MARKER_FILE",
    "PROGRESS_CANCEL_MARKER_FILE",
    "AGENT_PROGRESS_CANCEL_MARKER",
    "PROGRESS_CANCEL_MARKER",
  );
  if (explicit) return explicit;
  return join(firstEnv(env, "RUNNER_TEMP") || tmpdir(), PROGRESS_CANCEL_MARKER_FILENAME);
}

export function writeProgressCancelMarker(path: string, login: string): void {
  const markerPath = path.trim();
  if (!markerPath) {
    throw new Error("progress cancel marker path is empty");
  }
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${cleanLogin(login)}\n`, "utf8");
}

export function clearProgressCancelMarker(path: string): void {
  const markerPath = path.trim();
  if (!markerPath) return;

  try {
    rmSync(markerPath, { force: true });
  } catch {
    // Best effort: cleanup must not hide the cancellation failure.
  }
}

export function readProgressCancelMarker(path: string): string {
  const markerPath = path.trim();
  if (!markerPath || !existsSync(markerPath)) return "";

  try {
    return cleanLogin(readFileSync(markerPath, "utf8").split(/\r?\n/, 1)[0] ?? "");
  } catch {
    return "";
  }
}

export function reconcileProgressCancelStatus(input: {
  status: string;
  markerFile: string;
}): ReconciledProgressStatus {
  const cancelledBy = readProgressCancelMarker(input.markerFile);
  if (cancelledBy) {
    return { status: "cancelled", cancelled: true, cancelledBy };
  }
  return {
    status: normalizeRunStatus(input.status),
    cancelled: false,
    cancelledBy: "",
  };
}

export function cleanLogin(login: string): string {
  return String(login || "")
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/^@+/, "")
    .trim()
    .slice(0, 100);
}

function normalizeRunStatus(status: string): RunStatus {
  const normalized = String(status || "").trim().toLowerCase();
  if (
    normalized === "success" ||
    normalized === "no_changes" ||
    normalized === "verify_failed" ||
    normalized === "unsupported" ||
    normalized === "cancelled"
  ) {
    return normalized;
  }
  return "failed";
}

function firstEnv(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}
