// CLI: publish a Sepo GitHub Release from the checked-out target ref.
// Usage: node .agent/dist/cli/publish-release.js
// Env: GITHUB_REPOSITORY, VERSION, DRAFT, PRERELEASE, UPDATE_EXISTING

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gh } from "../github.js";
import { setOutput } from "../output.js";
import { parseReleaseVersion } from "../release-version.js";

function bool(value: string, defaultValue: boolean): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(".agent/package.json", "utf8")) as { version?: unknown };
  return String(pkg.version || "").trim();
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function releaseUrl(tag: string): string {
  try {
    const raw = gh(["release", "view", tag, "--json", "url"]);
    return String((JSON.parse(raw) as { url?: unknown }).url || "");
  } catch {
    return "";
  }
}

function tagTarget(tag: string): string {
  try {
    return git(["rev-parse", "-q", "--verify", `refs/tags/${tag}^{}`]);
  } catch {
    return "";
  }
}

const repo = process.env.GITHUB_REPOSITORY || "";
if (repo !== "self-evolving/repo") {
  console.error("Release publish is only supported in self-evolving/repo");
  process.exitCode = 2;
} else {
  const packageRelease = parseReleaseVersion(packageVersion());
  const requested = String(process.env.VERSION || "").trim()
    ? parseReleaseVersion(process.env.VERSION || "")
    : packageRelease;

  if (requested.version !== packageRelease.version) {
    console.error(`Requested version ${requested.version} does not match .agent/package.json ${packageRelease.version}`);
    process.exitCode = 1;
  } else {
    const targetSha = git(["rev-parse", "HEAD"]);
    const existingTagTarget = tagTarget(requested.tag);
    if (existingTagTarget && existingTagTarget !== targetSha) {
      console.error(`Existing tag ${requested.tag} points at ${existingTagTarget}, not ${targetSha}`);
      process.exitCode = 1;
    } else {
      const draft = bool(process.env.DRAFT || "", true);
      const prereleaseInput = String(process.env.PRERELEASE || "auto").trim().toLowerCase();
      const prerelease = prereleaseInput === "auto" || !prereleaseInput
        ? packageRelease.major === 0 || packageRelease.prereleaseLabel !== ""
        : bool(prereleaseInput, false);
      const updateExisting = bool(process.env.UPDATE_EXISTING || "", false);
      const existingReleaseUrl = releaseUrl(requested.tag);

      if (existingReleaseUrl && !updateExisting) {
        console.error(`Release ${requested.tag} already exists; set update_existing=true to update it`);
        process.exitCode = 1;
      } else {
        const notesFile = join(process.env.RUNNER_TEMP || "/tmp", `release-notes-${randomBytes(8).toString("hex")}.md`);
        writeFileSync(notesFile, `Sepo ${requested.tag}\n`, "utf8");

        const args = existingReleaseUrl
          ? ["release", "edit", requested.tag]
          : ["release", "create", requested.tag, "--target", targetSha];
        args.push("--title", requested.tag, "--notes-file", notesFile);
        if (draft) args.push("--draft");
        if (prerelease) args.push("--prerelease");

        gh(args);
        const url = releaseUrl(requested.tag);
        setOutput("version", requested.version);
        setOutput("tag", requested.tag);
        setOutput("target_sha", targetSha);
        setOutput("release_url", url);
        setOutput("release_action", existingReleaseUrl ? "updated" : "created");
        console.log(`${existingReleaseUrl ? "Updated" : "Created"} release ${requested.tag}`);
      }
    }
  }
}
