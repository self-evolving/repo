import { strict as assert } from "node:assert";
import test from "node:test";

import {
  appendFinalResponseMarker,
  finalResponseMarker,
  hasFinalResponseMarker,
} from "../self-authored-response.js";

test("finalResponseMarker normalizes run ids", () => {
  assert.equal(
    finalResponseMarker(" run 12/<x> "),
    "<!-- sepo-final-response:run-run-12--x- -->",
  );
});

test("appendFinalResponseMarker replaces supplied final-response markers", () => {
  const body = appendFinalResponseMarker(
    "Answer.\n\n<!-- sepo-final-response:run-untrusted -->",
    "456",
  );

  assert.equal(body, "Answer.\n\n<!-- sepo-final-response:run-456 -->");
  assert.equal(hasFinalResponseMarker(body), true);
  assert.equal(hasFinalResponseMarker("Answer."), false);
});
