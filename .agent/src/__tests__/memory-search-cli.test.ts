import { test } from "node:test";
import { strict as assert } from "node:assert";

import { runMemorySearchCli } from "../cli/memory/search.js";

function outputBuffer() {
  let text = "";
  return {
    write(chunk: string) { text += chunk; },
    read() { return text; },
  };
}

test("runMemorySearchCli returns a clean error when the memory directory is missing", () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const exitCode = runMemorySearchCli(
    ["--dir", "/tmp/definitely-missing-memory-dir", "memory"],
    { stdout, stderr },
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout.read(), "");
  assert.match(stderr.read(), /Memory directory not found/);
});
