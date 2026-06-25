import { strict as assert } from "node:assert";
import { test } from "node:test";

import { firstEnv } from "../env.js";

test("firstEnv returns the first non-empty trimmed environment value", () => {
  assert.equal(
    firstEnv(
      {
        FIRST: "  ",
        SECOND: " value ",
        THIRD: "ignored",
      },
      "FIRST",
      "SECOND",
      "THIRD",
    ),
    "value",
  );
});

test("firstEnv returns empty string when no configured names have values", () => {
  assert.equal(firstEnv({ FIRST: "" }, "FIRST", "MISSING"), "");
});
