import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  parseSessionPolicy,
  sessionModeForPolicy,
  tracksThreadState,
  attemptsResume,
  requiresResumeContinuity,
} from "../session-policy.js";

test("parseSessionPolicy accepts only explicit policy values", () => {
  assert.equal(parseSessionPolicy("none"), "none");
  assert.equal(parseSessionPolicy("track-only"), "track-only");
  assert.equal(parseSessionPolicy("resume-best-effort"), "resume-best-effort");
  assert.equal(parseSessionPolicy("resume-required"), "resume-required");
});

test("parseSessionPolicy rejects empty or invalid values", () => {
  assert.equal(parseSessionPolicy(""), null);
  assert.equal(parseSessionPolicy(undefined), null);
  assert.equal(parseSessionPolicy("wat"), null);
});

test("sessionModeForPolicy derives exec vs persistent explicitly from policy", () => {
  assert.equal(sessionModeForPolicy("none"), "exec");
  assert.equal(sessionModeForPolicy("track-only"), "persistent");
  assert.equal(sessionModeForPolicy("resume-best-effort"), "persistent");
  assert.equal(sessionModeForPolicy("resume-required"), "persistent");
});

test("policy predicates separate tracking, resume, and strict continuity", () => {
  assert.equal(tracksThreadState("none"), false);
  assert.equal(tracksThreadState("track-only"), true);
  assert.equal(tracksThreadState("resume-best-effort"), true);
  assert.equal(tracksThreadState("resume-required"), true);

  assert.equal(attemptsResume("none"), false);
  assert.equal(attemptsResume("track-only"), false);
  assert.equal(attemptsResume("resume-best-effort"), true);
  assert.equal(attemptsResume("resume-required"), true);

  assert.equal(requiresResumeContinuity("none"), false);
  assert.equal(requiresResumeContinuity("track-only"), false);
  assert.equal(requiresResumeContinuity("resume-best-effort"), false);
  assert.equal(requiresResumeContinuity("resume-required"), true);
});
