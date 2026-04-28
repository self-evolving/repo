import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildPushToRefArgs } from "../git.js";

test("buildPushToRefArgs pushes HEAD to the target ref", () => {
  assert.deepEqual(
    buildPushToRefArgs("https://example.com/repo.git", "feature"),
    ["push", "https://example.com/repo.git", "HEAD:feature"],
  );
});

test("buildPushToRefArgs includes a force-with-lease for branch updates", () => {
  assert.deepEqual(
    buildPushToRefArgs("https://example.com/repo.git", "feature", {
      forceWithLeaseOid: "abc123",
    }),
    [
      "push",
      "--force-with-lease=refs/heads/feature:abc123",
      "https://example.com/repo.git",
      "HEAD:feature",
    ],
  );
});
