import { buildThreadKey } from "./envelope.js";
import {
  type PushOptions,
  type ThreadBundleRestoreStatus,
  type ThreadResumeStatus,
  type ThreadState,
  markThreadCompleted,
  markThreadFailed,
  markThreadRunning,
} from "./thread-state.js";

export interface SessionRunStateInput {
  repoRoot: string;
  repoSlug: string;
  route: string;
  targetKind: string;
  targetNumber: number;
  lane?: string;
  expectedThreadKey?: string;
  exitCode: number;
  acpxRecordId?: string;
  acpxSessionId?: string;
  resumeStatus?: ThreadResumeStatus;
  lastResumeError?: string;
  resumedFromSessionId?: string;
  bundleRestoreStatus?: ThreadBundleRestoreStatus;
  lastBundleRestoreError?: string;
  forkedFromThreadKey?: string;
  forkedFromAcpxSessionId?: string;
  lastRunUrl?: string;
  pushOptions?: PushOptions;
}

export function persistSessionRunState(input: SessionRunStateInput): ThreadState {
  const threadKey = buildThreadKey({
    repo_slug: input.repoSlug,
    route: input.route,
    target_kind: input.targetKind,
    target_number: input.targetNumber,
    lane: input.lane,
  });
  if (input.expectedThreadKey && input.expectedThreadKey !== threadKey) {
    throw new Error(
      `Thread key mismatch: expected ${threadKey}, received ${input.expectedThreadKey}`,
    );
  }

  const running = markThreadRunning(
    threadKey,
    input.repoRoot,
    {
      last_run_url: input.lastRunUrl || "",
      resume_status: "not_attempted",
      last_resume_error: "",
      resumed_from_session_id: "",
      bundle_restore_status: input.bundleRestoreStatus || "not_attempted",
      last_bundle_restore_error: input.lastBundleRestoreError || "",
      ...(input.forkedFromThreadKey
        ? { forked_from_thread_key: input.forkedFromThreadKey }
        : {}),
      ...(input.forkedFromAcpxSessionId
        ? { forked_from_acpx_session_id: input.forkedFromAcpxSessionId }
        : {}),
    },
    input.pushOptions,
  );

  const resumeUpdates = {
    resume_status: input.resumeStatus || "not_attempted",
    last_resume_error: input.lastResumeError || "",
    resumed_from_session_id: input.resumedFromSessionId || "",
  };
  if (input.exitCode !== 0) {
    return markThreadFailed(
      threadKey,
      running,
      input.repoRoot,
      resumeUpdates,
      input.pushOptions,
    );
  }

  const identityUpdates = input.acpxRecordId && input.acpxSessionId
    ? {
        acpxRecordId: input.acpxRecordId,
        acpxSessionId: input.acpxSessionId,
      }
    : {};
  return markThreadCompleted(
    threadKey,
    running,
    input.repoRoot,
    {
      ...resumeUpdates,
      ...identityUpdates,
    },
    input.pushOptions,
  );
}
