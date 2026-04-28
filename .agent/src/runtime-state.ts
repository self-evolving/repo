// Pure helpers for the runtime thread-state state machine.
//
// These helpers are intentionally side-effect free so tests can validate
// session continuity behavior without shelling out to git or acpx.

import type { SessionEnsureOutcome, SessionIdentity } from "./acpx-adapter.js";
import type { SessionPolicy } from "./session-policy.js";
import type { ThreadResumeStatus, ThreadState } from "./thread-state.js";
import { attemptsResume, requiresResumeContinuity } from "./session-policy.js";

export interface ThreadResumeFields {
  resume_status: ThreadResumeStatus;
  last_resume_error: string;
  resumed_from_session_id: string;
}

export function resumeSessionIdFromState(
  policy: SessionPolicy,
  state: ThreadState | null,
): string | undefined {
  if (!attemptsResume(policy)) {
    return undefined;
  }
  return state?.acpxSessionId || undefined;
}

export function resumeSessionIdFromForkSource(
  policy: SessionPolicy,
  existingState: ThreadState | null,
  forkAcpxSessionId: string | undefined,
): string | undefined {
  if (!attemptsResume(policy) || existingState?.acpxSessionId) {
    return undefined;
  }
  const normalized = String(forkAcpxSessionId || "").trim();
  return normalized || undefined;
}

export function shouldUseContinuationPrompt(
  existingState: ThreadState | null,
  resumeSessionId: string | undefined,
): boolean {
  return Boolean(existingState?.acpxSessionId && resumeSessionId === existingState.acpxSessionId);
}

export function buildRunningThreadStateFields(): ThreadResumeFields {
  return {
    resume_status: "not_attempted",
    last_resume_error: "",
    resumed_from_session_id: "",
  };
}

export function buildThreadStateFieldsFromEnsureOutcome(
  outcome: SessionEnsureOutcome,
): ThreadResumeFields {
  switch (outcome.kind) {
    case "resumed":
      return {
        resume_status: "resumed",
        last_resume_error: "",
        resumed_from_session_id: outcome.resumedFromSessionId,
      };
    case "resume_fallback":
      return {
        resume_status: "fallback_fresh",
        last_resume_error: outcome.error,
        resumed_from_session_id: outcome.resumedFromSessionId,
      };
    case "failed":
      return {
        resume_status: "failed",
        last_resume_error: outcome.error,
        resumed_from_session_id: outcome.resumedFromSessionId || "",
      };
    case "fresh":
    case "not_applicable":
    default:
      return buildRunningThreadStateFields();
  }
}

export function buildCompletedThreadStateUpdates(args: {
  outcome: SessionEnsureOutcome;
  identity: SessionIdentity | null;
}): Partial<ThreadState> {
  const updates: Partial<ThreadState> = {
    ...buildThreadStateFieldsFromEnsureOutcome(args.outcome),
  };

  if (args.identity) {
    updates.acpxRecordId = args.identity.acpxRecordId;
    updates.acpxSessionId = args.identity.acpxSessionId;
  }

  return updates;
}

export function buildFailedThreadStateUpdates(
  outcome: SessionEnsureOutcome,
): Partial<ThreadState> {
  return buildThreadStateFieldsFromEnsureOutcome(outcome);
}

export function shouldFailRunBecauseOfEnsureOutcome(
  policy: SessionPolicy,
  outcome: SessionEnsureOutcome,
): boolean {
  if (!requiresResumeContinuity(policy)) {
    return false;
  }
  return outcome.kind === "resume_fallback" || outcome.kind === "failed";
}

export function shouldFailRunBecauseOfThreadStateError(policy: SessionPolicy): boolean {
  return requiresResumeContinuity(policy);
}

export function shouldFailBecauseRequiredResumeIdentityMissing(
  policy: SessionPolicy,
  existingState: ThreadState | null,
  resumeSessionId: string | undefined,
): boolean {
  return requiresResumeContinuity(policy) && existingState !== null && !resumeSessionId;
}
