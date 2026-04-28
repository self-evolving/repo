#!/usr/bin/env node
// CLI: create a GitHub Discussion from a markdown body file.
// Env: GITHUB_REPOSITORY, DISCUSSION_CATEGORY, DISCUSSION_TITLE, BODY_FILE,
//      DISCUSSION_FOOTER (optional)

import { existsSync, readFileSync } from "node:fs";
import { createRepositoryDiscussion } from "../discussion.js";
import { setOutput } from "../output.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() || "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const [owner, repo, extra] = slug.split("/");
  if (!owner || !repo || extra) {
    throw new Error(`GITHUB_REPOSITORY must be owner/repo (got: ${slug || "missing"})`);
  }
  return { owner, repo };
}

function main(): number {
  try {
    const { owner, repo } = parseRepoSlug(requiredEnv("GITHUB_REPOSITORY"));
    const category = requiredEnv("DISCUSSION_CATEGORY");
    const title = requiredEnv("DISCUSSION_TITLE");
    const bodyFile = requiredEnv("BODY_FILE");
    const footer = process.env.DISCUSSION_FOOTER?.trim() || "";

    if (!existsSync(bodyFile)) {
      throw new Error(`Discussion body file was not produced: ${bodyFile}`);
    }

    const body = readFileSync(bodyFile, "utf8").trim();
    if (!body) {
      throw new Error("Discussion body is empty");
    }

    const discussion = createRepositoryDiscussion(
      owner,
      repo,
      category,
      title,
      footer ? `${body}\n\n---\n${footer}` : body,
    );

    setOutput("discussion_url", discussion.url);
    console.log(`Discussion created: ${discussion.url}`);
    return 0;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exitCode = main();
