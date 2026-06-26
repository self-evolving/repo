import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { firstEnv } from "./env.js";
import type { RunStatus } from "./response.js";

export const PROGRESS_CANCEL_MARKER_FILENAME = "agent-progress-cancelled";

export interface ReconciledProgressStatus {
  status: RunStatus;
  cancelled: boolean;
  cancelledBy: string;
}

export type ProgressCancelMarkerState = "confirmed" | "failed";

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

export function writeProgressCancelMarker(
  path: string,
  login: string,
  state: ProgressCancelMarkerState = "confirmed",
): void {
  const markerPath = path.trim();
  if (!markerPath) {
    throw new Error("progress cancel marker path is empty");
  }
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${formatProgressCancelMarker(login, state)}\n`, "utf8");
}

export function readProgressCancelMarker(path: string): string {
  const markerPath = path.trim();
  if (!markerPath || !existsSync(markerPath)) return "";

  try {
    return parseProgressCancelMarker(readFileSync(markerPath, "utf8").split(/\r?\n/, 1)[0] ?? "");
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

function formatProgressCancelMarker(login: string, state: ProgressCancelMarkerState): string {
  const cleaned = cleanLogin(login);
  if (state === "confirmed") return cleaned;
  return `${state}:${cleaned}`;
}

function parseProgressCancelMarker(value: string): string {
  const marker = String(value || "").trim();
  if (marker.startsWith("failed:")) return "";
  if (marker.startsWith("confirmed:")) return cleanLogin(marker.slice("confirmed:".length));
  return cleanLogin(marker);
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
