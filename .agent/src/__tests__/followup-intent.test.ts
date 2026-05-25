import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  normalizeFollowupIntent,
  parseFollowupIntentMode,
  shouldConsiderImplicitFollowup,
} from "../followup-intent.js";

test("parseFollowupIntentMode defaults to agent-label and accepts false as disabled", () => {
  assert.equal(parseFollowupIntentMode(""), "agent-label");
  assert.equal(parseFollowupIntentMode("agent-label"), "agent-label");
  assert.equal(parseFollowupIntentMode("disabled"), "disabled");
  assert.equal(parseFollowupIntentMode("false"), "disabled");
  assert.throws(() => parseFollowupIntentMode("true"), /AGENT_FOLLOWUP_INTENT_MODE/);
});

test("shouldConsiderImplicitFollowup requires a supported labeled follow-up event", () => {
  assert.equal(
    shouldConsiderImplicitFollowup(
      "issue_comment",
      {
        action: "created",
        issue: { labels: [{ name: "agent" }] },
      },
      "agent-label",
    ),
    true,
  );
  assert.equal(
    shouldConsiderImplicitFollowup(
      "issue_comment",
      {
        action: "created",
        issue: { labels: [{ name: "bug" }] },
      },
      "agent-label",
    ),
    false,
  );
  assert.equal(
    shouldConsiderImplicitFollowup(
      "issues",
      {
        action: "edited",
        issue: { labels: [{ name: "agent" }] },
      },
      "agent-label",
    ),
    false,
  );
  assert.equal(
    shouldConsiderImplicitFollowup(
      "issue_comment",
      {
        action: "edited",
        issue: { labels: ["agent"] },
      },
      "agent-label",
    ),
    false,
  );
  assert.equal(
    shouldConsiderImplicitFollowup(
      "pull_request_review_comment",
      {
        action: "edited",
        pull_request: { labels: ["agent"] },
      },
      "agent-label",
    ),
    false,
  );
  assert.equal(
    shouldConsiderImplicitFollowup(
      "pull_request_review",
      {
        action: "submitted",
        pull_request: { labels: ["agent"] },
      },
      "agent-label",
    ),
    true,
  );
  assert.equal(
    shouldConsiderImplicitFollowup(
      "pull_request_review",
      {
        action: "submitted",
        pull_request: { labels: ["agent"] },
      },
      "disabled",
    ),
    false,
  );
});

test("normalizeFollowupIntent accepts respond and ignore outcomes only", () => {
  assert.deepEqual(
    normalizeFollowupIntent('{"outcome":"respond","confidence":"high","summary":"question"}'),
    {
      outcome: "respond",
      confidence: "high",
      summary: "question",
    },
  );
  assert.equal(
    normalizeFollowupIntent('```json\n{"outcome":"ignore","confidence":"medium","summary":"thanks"}\n```').outcome,
    "ignore",
  );
  assert.throws(
    () => normalizeFollowupIntent('{"route":"implement","confidence":"high"}'),
    /Unsupported follow-up intent outcome/,
  );
});
