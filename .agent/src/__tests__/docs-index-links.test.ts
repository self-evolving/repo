import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = path.resolve(__dirname, "../../..");
const docsRoot = path.join(repoRoot, ".agent/docs");

function internalMarkdownLinks(markdown: string): string[] {
  return Array.from(markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g), ([, target]) => target).filter(
    (target) =>
      !!target &&
      !target.startsWith("#") &&
      !target.startsWith("http://") &&
      !target.startsWith("https://") &&
      !target.startsWith("mailto:"),
  );
}

function stripAnchor(target: string): string {
  return target.split("#", 1)[0];
}

test("docs index links resolve under the published docs namespace", () => {
  const index = readFileSync(path.join(docsRoot, "README.md"), "utf8");
  const links = internalMarkdownLinks(index);

  assert.ok(links.length > 0, "docs index should contain internal markdown links");

  for (const target of links) {
    assert.match(
      target,
      /^\.\.\/docs\//,
      `docs index link should include the docs namespace for Quartz: ${target}`,
    );

    const sourceTarget = path.normalize(path.join(docsRoot, stripAnchor(target)));
    const sourceRelative = path.relative(docsRoot, sourceTarget);
    assert.ok(
      sourceRelative && !sourceRelative.startsWith("..") && !path.isAbsolute(sourceRelative),
      `docs index link should still resolve inside .agent/docs: ${target}`,
    );
    assert.ok(existsSync(sourceTarget), `docs index link should point to an existing source file: ${target}`);

    const publishedSlug = target.replace(/^\.\.\//, "").replace(/\.md(#.*)?$/, "$1");
    assert.match(
      publishedSlug,
      /^docs\//,
      `published docs slug should not be rooted outside /docs: ${target}`,
    );
  }
});
