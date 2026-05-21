import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = path.resolve(__dirname, "../../..");
const docsRoot = path.join(repoRoot, ".agent/docs");

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(abs));
    else if (entry.isFile() && abs.toLowerCase().endsWith(".md")) out.push(abs);
  }
  return out;
}

function parseFrontmatter(markdown: string): { frontmatter: string; body: string } | null {
  if (!markdown.startsWith("---")) return null;
  const close = markdown.indexOf("\n---", 3);
  if (close < 0) return null;
  const bodyStart = markdown.indexOf("\n", close + 4);
  return {
    frontmatter: markdown.slice(0, close),
    body: bodyStart >= 0 ? markdown.slice(bodyStart + 1) : "",
  };
}

function internalLinks(markdown: string): string[] {
  return Array.from(markdown.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g), ([, target]) =>
    target.trim(),
  ).filter(
    (t) =>
      t.length > 0 &&
      !t.startsWith("#") &&
      !t.startsWith("/") &&
      !/^[a-z][a-z0-9+.-]*:/i.test(t),
  );
}

function stripLinkSuffix(link: string): string {
  const idx = [link.indexOf("#"), link.indexOf("?")].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return idx === undefined ? link : link.slice(0, idx);
}

test("no .agent/docs/**/README.md exists", () => {
  for (const file of walkMarkdown(docsRoot)) {
    assert.notEqual(
      path.basename(file).toLowerCase(),
      "readme.md",
      `unexpected README.md (use index.md): ${path.relative(repoRoot, file)}`,
    );
  }
});

test("every doc has frontmatter with a non-empty title", () => {
  for (const file of walkMarkdown(docsRoot)) {
    const raw = readFileSync(file, "utf8");
    const parsed = parseFrontmatter(raw);
    assert.ok(parsed, `missing frontmatter: ${path.relative(repoRoot, file)}`);
    const title = parsed.frontmatter.match(/^title:\s*(.+?)\s*$/m)?.[1];
    assert.ok(
      title && title.replace(/^["']|["']$/g, "").trim(),
      `missing or empty title: ${path.relative(repoRoot, file)}`,
    );
  }
});

test("no doc body starts with an H1 heading", () => {
  for (const file of walkMarkdown(docsRoot)) {
    const raw = readFileSync(file, "utf8");
    const parsed = parseFrontmatter(raw);
    const body = (parsed?.body ?? raw).replace(/^\s+/, "");
    assert.doesNotMatch(
      body,
      /^#\s+/,
      `doc body should not start with an H1 (frontmatter title is the page title): ${path.relative(repoRoot, file)}`,
    );
  }
});

test("relative links resolve inside .agent/docs", () => {
  for (const file of walkMarkdown(docsRoot)) {
    const raw = readFileSync(file, "utf8");
    for (const link of internalLinks(raw)) {
      const linkPath = stripLinkSuffix(link);
      if (!linkPath) continue;
      const target = path.resolve(path.dirname(file), linkPath);
      const rel = path.relative(docsRoot, target);
      assert.ok(
        rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)),
        `relative link escapes .agent/docs (use a GitHub URL): ${path.relative(repoRoot, file)} -> ${link}`,
      );
      assert.ok(
        existsSync(target),
        `relative link target does not exist: ${path.relative(repoRoot, file)} -> ${link}`,
      );
    }
  }
});
