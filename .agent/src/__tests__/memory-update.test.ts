import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  addBullet,
  appendDailyBullet,
  dailyLogPath,
  removeBullet,
  replaceBullet,
  todayDateUtc,
} from "../memory-update.js";

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mem-update-"));
  writeFileSync(
    join(root, "MEMORY.md"),
    ["# Memory", "", "## Durable", "- existing entry", ""].join("\n"),
  );
  writeFileSync(
    join(root, "PROJECT.md"),
    ["# Project", "", "## Open Questions", "- should we support semantic search?", ""].join("\n"),
  );
  return root;
}

test("addBullet inserts under the matching section and normalizes the prefix", () => {
  const root = newRoot();
  const result = addBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    "   prefer on-demand search over pre-built indices",
  );
  assert.equal(result.action.kind, "added");
  const content = readFileSync(join(root, "MEMORY.md"), "utf8");
  assert.match(content, /- prefer on-demand search over pre-built indices/);
  assert.match(content, /- existing entry/);
});

test("addBullet initializes an empty editable file with the requested section", () => {
  const root = newRoot();
  writeFileSync(join(root, "MEMORY.md"), "", "utf8");
  const result = addBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    "prefer concise durable notes",
  );

  assert.equal(result.action.kind, "added");
  assert.equal(
    readFileSync(join(root, "MEMORY.md"), "utf8"),
    ["# Memory", "", "## Durable", "- prefer concise durable notes", ""].join("\n"),
  );
});

test("addBullet is a no-op when the bullet already exists", () => {
  const root = newRoot();
  const result = addBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    "existing entry",
  );
  assert.equal(result.action.kind, "noop");
});

test("addBullet reports missing section without mutating the file", () => {
  const root = newRoot();
  const before = readFileSync(join(root, "MEMORY.md"), "utf8");
  const result = addBullet(
    { root, file: "MEMORY.md", section: "Nonexistent" },
    "something",
  );
  assert.equal(result.action.kind, "missing_section");
  assert.equal(readFileSync(join(root, "MEMORY.md"), "utf8"), before);
});

test("replaceBullet finds a case-insensitive substring and swaps the line", () => {
  const root = newRoot();
  const result = replaceBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    "EXISTING entry",
    "updated entry",
  );
  assert.equal(result.action.kind, "replaced");
  const content = readFileSync(join(root, "MEMORY.md"), "utf8");
  assert.match(content, /- updated entry/);
  assert.doesNotMatch(content, /- existing entry/);
});

test("replaceBullet reports ambiguous_match when multiple distinct bullets match", () => {
  const root = newRoot();
  writeFileSync(
    join(root, "MEMORY.md"),
    ["# Memory", "", "## Durable", "- alpha one", "- alpha two", ""].join("\n"),
  );
  const result = replaceBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    "alpha",
    "updated entry",
  );
  assert.equal(result.action.kind, "ambiguous_match");
  assert.deepEqual(result.action.candidates, ["- alpha one", "- alpha two"]);
});

test("replaceBullet dedupes when the replacement already exists elsewhere in the section", () => {
  const root = newRoot();
  writeFileSync(
    join(root, "MEMORY.md"),
    ["# Memory", "", "## Durable", "- alpha", "- beta", ""].join("\n"),
  );
  const result = replaceBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    "beta",
    "alpha",
  );
  assert.equal(result.action.kind, "deduped");
  const content = readFileSync(join(root, "MEMORY.md"), "utf8");
  assert.equal((content.match(/^- alpha$/gm) || []).length, 1);
  assert.doesNotMatch(content, /- beta/);
});

test("replaceBullet reports missing_match when nothing matches", () => {
  const root = newRoot();
  const result = replaceBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    "missing text",
    "new entry",
  );
  assert.equal(result.action.kind, "missing_match");
});

test("removeBullet deletes the first matching bullet", () => {
  const root = newRoot();
  const result = removeBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    "existing entry",
  );
  assert.equal(result.action.kind, "removed");
  const content = readFileSync(join(root, "MEMORY.md"), "utf8");
  assert.doesNotMatch(content, /- existing entry/);
});

test("removeBullet reports ambiguous_match when multiple distinct bullets match", () => {
  const root = newRoot();
  writeFileSync(
    join(root, "MEMORY.md"),
    ["# Memory", "", "## Durable", "- alpha one", "- alpha two", ""].join("\n"),
  );
  const result = removeBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    "alpha",
  );
  assert.equal(result.action.kind, "ambiguous_match");
  assert.deepEqual(result.action.candidates, ["- alpha one", "- alpha two"]);
});

test("appendDailyBullet creates the daily file with the expected header", () => {
  const root = newRoot();
  const result = appendDailyBullet(root, "shipped v3 of agent memory");
  assert.equal(result.action.kind, "added");
  const path = dailyLogPath(root, todayDateUtc());
  const content = readFileSync(path, "utf8");
  assert.match(content, /^# Daily log for \d{4}-\d{2}-\d{2}$/m);
  assert.match(content, /^## Activity$/m);
  assert.match(content, /- shipped v3 of agent memory/);
});

test("appendDailyBullet is a no-op when the bullet already exists", () => {
  const root = newRoot();
  appendDailyBullet(root, "same bullet");
  const result = appendDailyBullet(root, "same bullet");
  assert.equal(result.action.kind, "noop");
});

test("addBullet rejects empty bullets", () => {
  const root = newRoot();
  assert.throws(
    () => addBullet({ root, file: "MEMORY.md", section: "Durable" }, ""),
    /non-empty/,
  );
});

test("addBullet accepts long bullets without truncating", () => {
  const root = newRoot();
  const longText = "x".repeat(400);
  const result = addBullet(
    { root, file: "MEMORY.md", section: "Durable" },
    longText,
  );
  assert.equal(result.action.kind, "added");
  const content = readFileSync(join(root, "MEMORY.md"), "utf8");
  assert.match(content, new RegExp(`- ${longText}`));
});
