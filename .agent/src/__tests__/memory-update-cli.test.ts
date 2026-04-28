import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { runMemoryUpdateCli } from "../cli/memory/update.js";

function outputBuffer() {
  let text = "";
  return {
    write(chunk: string) { text += chunk; },
    read() { return text; },
  };
}

test("runMemoryUpdateCli reports ambiguous matches without mutating the file", () => {
  const root = mkdtempSync(join(tmpdir(), "mem-update-cli-"));
  const path = join(root, "MEMORY.md");
  writeFileSync(
    path,
    ["# Memory", "", "## Durable", "- alpha one", "- alpha two", ""].join("\n"),
  );

  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const exitCode = runMemoryUpdateCli(
    ["remove", "--dir", root, "--file", "MEMORY.md", "--section", "Durable", "--match", "alpha"],
    { stdout, stderr },
  );

  assert.equal(exitCode, 2);
  assert.equal(stdout.read(), "");
  const stderrText = stderr.read();
  assert.match(stderrText, /multiple bullets matched: alpha/);
  assert.match(stderrText, /^- alpha one$/m);
  assert.match(stderrText, /^- alpha two$/m);
});

test("runMemoryUpdateCli reports deduped when --with already matches a different bullet", () => {
  // Semantics: the source bullet ("alpha") is removed and the existing
  // --with target ("beta") is kept, collapsing the section to one entry.
  const root = mkdtempSync(join(tmpdir(), "mem-update-cli-"));
  const path = join(root, "MEMORY.md");
  writeFileSync(
    path,
    ["# Memory", "", "## Durable", "- alpha", "- beta", ""].join("\n"),
  );

  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const exitCode = runMemoryUpdateCli(
    [
      "replace",
      "--dir", root,
      "--file", "MEMORY.md",
      "--section", "Durable",
      "--match", "alpha",
      "--with", "beta",
    ],
    { stdout, stderr },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.match(stdout.read(), /collapsed duplicate bullet/);

  const after = readFileSync(path, "utf8");
  assert.match(after, /^- beta$/m);
  assert.doesNotMatch(after, /^- alpha$/m);
  // Only one bullet remains under Durable.
  const bullets = after.split("\n").filter((line) => /^-\s/.test(line));
  assert.equal(bullets.length, 1);
});
