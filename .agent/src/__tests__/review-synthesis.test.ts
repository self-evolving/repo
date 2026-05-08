import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildReviewSynthesisHeadMarker,
  extractReviewSynthesisHeadSha,
  isReviewSynthesisBody,
} from "../review-synthesis.js";

test("buildReviewSynthesisHeadMarker formats non-empty head SHAs", () => {
  assert.equal(
    buildReviewSynthesisHeadMarker(" abc123 "),
    "<!-- sepo-agent-review-synthesis-head: abc123 -->",
  );
});

test("buildReviewSynthesisHeadMarker omits blank head SHAs", () => {
  assert.equal(buildReviewSynthesisHeadMarker("   "), "");
});

test("extractReviewSynthesisHeadSha parses synthesis head markers", () => {
  const body = [
    "## AI Review Synthesis",
    "",
    "<!-- sepo-agent-review-synthesis -->",
    "<!-- sepo-agent-review-synthesis-head: AbC123def456 -->",
  ].join("\n");

  assert.equal(extractReviewSynthesisHeadSha(body), "AbC123def456");
});

test("extractReviewSynthesisHeadSha ignores missing or malformed markers", () => {
  assert.equal(extractReviewSynthesisHeadSha("## AI Review Synthesis"), "");
  assert.equal(
    extractReviewSynthesisHeadSha("<!-- sepo-agent-review-synthesis-head: not-a-sha -->"),
    "",
  );
});

test("isReviewSynthesisBody keeps legacy heading fallback", () => {
  assert.equal(isReviewSynthesisBody("## AI Review Synthesis\n\nlegacy body"), true);
});
