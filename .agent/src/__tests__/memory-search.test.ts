import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  formatMemorySearchResults,
  searchMemory,
  tokenizeMemorySearchQuery,
} from "../memory-search.js";

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "mem-search-"));
  writeFileSync(
    join(root, "MEMORY.md"),
    "# Memory\n\n## Durable\n- prefer explicit request ids over scan-and-filter\n- review dashboards live at grafana.internal/d/agent\n",
  );
  mkdirSync(join(root, "daily"), { recursive: true });
  writeFileSync(
    join(root, "daily", "2026-04-01.md"),
    "# Daily log for 2026-04-01\n\n## Activity\n- merged PR #209 introducing memory sync cursors\n- discussed rubric scope for #51\n",
  );
  mkdirSync(join(root, "github"), { recursive: true });
  writeFileSync(
    join(root, "github", "pull-209.json"),
    JSON.stringify({
      number: 209,
      title: "Add agent memory search",
      url: "https://github.com/self-evolving/repo/pull/209",
      state: "MERGED",
    }, null, 2) + "\n",
  );
  return root;
}

test("tokenizeMemorySearchQuery splits on non-alphanumerics and drops duplicates", () => {
  assert.deepEqual(
    tokenizeMemorySearchQuery("Memory Search — memory search!"),
    ["memory", "search"],
  );
});

test("tokenizeMemorySearchQuery keeps pure-number tokens", () => {
  assert.deepEqual(tokenizeMemorySearchQuery("issue #209"), ["issue", "209"]);
});

test("searchMemory ranks files with more matches higher and returns snippets", () => {
  const root = makeTree();
  const results = searchMemory("memory", { rootDir: root, limit: 5 });
  assert.ok(results.length >= 2);
  const paths = results.map((r) => r.path);
  assert.ok(paths.includes("MEMORY.md"));
  assert.ok(results[0]!.snippets.length >= 1);
});

test("searchMemory returns empty when query has no real tokens", () => {
  const root = makeTree();
  assert.deepEqual(searchMemory("!!!", { rootDir: root }), []);
});

test("searchMemory respects --limit", () => {
  const root = makeTree();
  const results = searchMemory("memory", { rootDir: root, limit: 1 });
  assert.equal(results.length, 1);
});

test("searchMemory prefers exact phrase and path matches in the JSON mirror", () => {
  const root = makeTree();
  const results = searchMemory("pull 209", { rootDir: root, limit: 5 });
  assert.equal(results[0]!.path, "github/pull-209.json");
});

test("searchMemory keeps path-only matches even when content does not contain the query", () => {
  const root = mkdtempSync(join(tmpdir(), "mem-search-"));
  mkdirSync(join(root, "github"), { recursive: true });
  writeFileSync(
    join(root, "github", "pull-209.json"),
    JSON.stringify({ number: 209, kind: "pr" }, null, 2) + "\n",
  );

  const results = searchMemory("pull", { rootDir: root, limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.path, "github/pull-209.json");
  assert.equal(results[0]!.snippets[0]!.lineNumber, 0);
  assert.match(results[0]!.snippets[0]!.text, /number|matched by filename/);
});

test("searchMemory ranks exact-phrase hits above the same tokens split across lines", () => {
  // Isolates the phrase-match bonus from the path bonus: neither filename
  // mentions the query. One file has the phrase in a single line, the other
  // has the two tokens on separate lines. The phrase-hit file should win.
  const root = mkdtempSync(join(tmpdir(), "mem-search-phrase-"));
  writeFileSync(
    join(root, "phrase.md"),
    "# Notes\n\n- we discussed memory sync in depth\n",
  );
  writeFileSync(
    join(root, "split.md"),
    "# Notes\n\n- memory context was considered\n- sync jobs run hourly\n",
  );

  const results = searchMemory("memory sync", { rootDir: root, limit: 5 });
  assert.equal(results.length, 2);
  assert.equal(results[0]!.path, "phrase.md");
  assert.ok(
    results[0]!.score > results[1]!.score,
    `expected phrase.md to outscore split.md (got ${results[0]!.score} vs ${results[1]!.score})`,
  );
});

test("searchMemory throws when the memory directory does not exist", () => {
  assert.throws(
    () => searchMemory("memory", { rootDir: "/tmp/definitely-missing-memory-dir" }),
    /Memory directory not found/,
  );
});

test("formatMemorySearchResults renders a readable header even with no matches", () => {
  const rendered = formatMemorySearchResults("x", [], "/tmp/empty");
  assert.match(rendered, /Memory search: "x"/);
  assert.match(rendered, /No matches/);
});
