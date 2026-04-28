import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildRunningThreadStateFields,
  buildThreadStateFieldsFromEnsureOutcome,
  buildCompletedThreadStateUpdates,
  buildFailedThreadStateUpdates,
  resumeSessionIdFromForkSource,
  resumeSessionIdFromState,
  shouldFailRunBecauseOfEnsureOutcome,
  shouldFailRunBecauseOfThreadStateError,
  shouldFailBecauseRequiredResumeIdentityMissing,
  shouldUseContinuationPrompt,
} from "../runtime-state.js";
import { createThreadState, updateThreadState } from "../thread-state.js";

test("resumeSessionIdFromState only returns ids for resume policies", () => {
  const state = updateThreadState(createThreadState("repo:issue:1:answer:default"), {
    acpxSessionId: "ses-123",
  });

  assert.equal(resumeSessionIdFromState("none", state), undefined);
  assert.equal(resumeSessionIdFromState("track-only", state), undefined);
  assert.equal(resumeSessionIdFromState("resume-best-effort", state), "ses-123");
  assert.equal(resumeSessionIdFromState("resume-required", state), "ses-123");
});

test("resumeSessionIdFromForkSource seeds resume-capable threads without destination identity", () => {
  const existingWithIdentity = updateThreadState(createThreadState("repo:issue:1:implement:default"), {
    acpxSessionId: "ses-destination",
  });
  const existingWithoutIdentity = createThreadState("repo:issue:1:implement:default");

  assert.equal(resumeSessionIdFromForkSource("none", null, "ses-source"), undefined);
  assert.equal(resumeSessionIdFromForkSource("track-only", null, "ses-source"), undefined);
  assert.equal(resumeSessionIdFromForkSource("resume-best-effort", existingWithIdentity, "ses-source"), undefined);
  assert.equal(resumeSessionIdFromForkSource("resume-best-effort", null, ""), undefined);
  assert.equal(resumeSessionIdFromForkSource("resume-best-effort", null, "ses-source"), "ses-source");
  assert.equal(
    resumeSessionIdFromForkSource("resume-best-effort", existingWithoutIdentity, "ses-source"),
    "ses-source",
  );
});

test("shouldUseContinuationPrompt only allows destination session resumes", () => {
  const existingWithIdentity = updateThreadState(createThreadState("repo:issue:1:answer:default"), {
    acpxSessionId: "ses-destination",
  });
  const existingWithoutIdentity = createThreadState("repo:issue:1:implement:default");

  assert.equal(shouldUseContinuationPrompt(existingWithIdentity, "ses-destination"), true);
  assert.equal(shouldUseContinuationPrompt(existingWithIdentity, "ses-source"), false);
  assert.equal(shouldUseContinuationPrompt(existingWithoutIdentity, "ses-source"), false);
  assert.equal(shouldUseContinuationPrompt(null, "ses-source"), false);
});

test("buildRunningThreadStateFields resets resume metadata for a new attempt", () => {
  assert.deepEqual(buildRunningThreadStateFields(), {
    resume_status: "not_attempted",
    last_resume_error: "",
    resumed_from_session_id: "",
  });
});

test("buildThreadStateFieldsFromEnsureOutcome maps resumed and fallback outcomes", () => {
  assert.deepEqual(
    buildThreadStateFieldsFromEnsureOutcome({ kind: "resumed", resumedFromSessionId: "ses-old" }),
    {
      resume_status: "resumed",
      last_resume_error: "",
      resumed_from_session_id: "ses-old",
    },
  );

  assert.deepEqual(
    buildThreadStateFieldsFromEnsureOutcome({
      kind: "resume_fallback",
      resumedFromSessionId: "ses-old",
      error: "expired",
    }),
    {
      resume_status: "fallback_fresh",
      last_resume_error: "expired",
      resumed_from_session_id: "ses-old",
    },
  );
});

test("buildThreadStateFieldsFromEnsureOutcome maps failed and non-resume outcomes", () => {
  assert.deepEqual(
    buildThreadStateFieldsFromEnsureOutcome({
      kind: "failed",
      resumedFromSessionId: "ses-old",
      error: "resume + fresh failed",
    }),
    {
      resume_status: "failed",
      last_resume_error: "resume + fresh failed",
      resumed_from_session_id: "ses-old",
    },
  );

  assert.deepEqual(
    buildThreadStateFieldsFromEnsureOutcome({ kind: "fresh" }),
    buildRunningThreadStateFields(),
  );
  assert.deepEqual(
    buildThreadStateFieldsFromEnsureOutcome({ kind: "not_applicable" }),
    buildRunningThreadStateFields(),
  );
});

test("buildCompletedThreadStateUpdates preserves identity absence and records fallback", () => {
  assert.deepEqual(
    buildCompletedThreadStateUpdates({
      outcome: {
        kind: "resume_fallback",
        resumedFromSessionId: "ses-old",
        error: "expired",
      },
      identity: null,
    }),
    {
      resume_status: "fallback_fresh",
      last_resume_error: "expired",
      resumed_from_session_id: "ses-old",
    },
  );

  assert.deepEqual(
    buildCompletedThreadStateUpdates({
      outcome: { kind: "resumed", resumedFromSessionId: "ses-old" },
      identity: { acpxRecordId: "rec-new", acpxSessionId: "ses-new" },
    }),
    {
      resume_status: "resumed",
      last_resume_error: "",
      resumed_from_session_id: "ses-old",
      acpxRecordId: "rec-new",
      acpxSessionId: "ses-new",
    },
  );
});

test("buildFailedThreadStateUpdates records resume failure details", () => {
  assert.deepEqual(
    buildFailedThreadStateUpdates({
      kind: "failed",
      resumedFromSessionId: "ses-old",
      error: "boom",
    }),
    {
      resume_status: "failed",
      last_resume_error: "boom",
      resumed_from_session_id: "ses-old",
    },
  );
});

test("strict continuity fails on fallback or thread-state errors only for resume-required", () => {
  assert.equal(
    shouldFailRunBecauseOfEnsureOutcome("resume-best-effort", {
      kind: "resume_fallback",
      resumedFromSessionId: "ses-old",
      error: "expired",
    }),
    false,
  );
  assert.equal(
    shouldFailRunBecauseOfEnsureOutcome("resume-required", {
      kind: "resume_fallback",
      resumedFromSessionId: "ses-old",
      error: "expired",
    }),
    true,
  );
  assert.equal(
    shouldFailRunBecauseOfEnsureOutcome("resume-required", { kind: "resumed", resumedFromSessionId: "ses-old" }),
    false,
  );
  assert.equal(
    shouldFailRunBecauseOfEnsureOutcome("resume-required", { kind: "fresh" }),
    false,
  );

  const existing = updateThreadState(createThreadState("repo:pr:7:fix-pr:default"), {
    acpxSessionId: "",
  });
  assert.equal(
    shouldFailBecauseRequiredResumeIdentityMissing("resume-required", existing, undefined),
    true,
  );
  assert.equal(
    shouldFailBecauseRequiredResumeIdentityMissing("resume-best-effort", existing, undefined),
    false,
  );
  assert.equal(
    shouldFailBecauseRequiredResumeIdentityMissing("resume-required", null, undefined),
    false,
  );

  assert.equal(shouldFailRunBecauseOfThreadStateError("track-only"), false);
  assert.equal(shouldFailRunBecauseOfThreadStateError("resume-best-effort"), false);
  assert.equal(shouldFailRunBecauseOfThreadStateError("resume-required"), true);
});
