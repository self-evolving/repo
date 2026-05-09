import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setOutput } from "./output.js";

const SOURCE_REPOSITORY = "self-evolving/repo";
const SEMVER_RE = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface CommandRunner {
  run(command: string, args: string[], cwd?: string): string;
}

export interface PublishReleaseOptions {
  repo: string;
  version: string;
  targetRef: string;
  draft: string;
  prerelease: string;
  updateExisting: string;
  packageJsonPath?: string;
  cwd?: string;
  runner?: CommandRunner;
}

export interface PublishReleaseResult {
  version: string;
  tag: string;
  targetSha: string;
  draft: boolean;
  prerelease: boolean;
  tagCreated: boolean;
  releaseAction: "created" | "updated";
  releaseUrl: string;
}

interface NormalizedVersion {
  version: string;
  tag: string;
  major: number;
  prereleaseLabel: string;
}

interface GitObjectPointer {
  type: string;
  sha: string;
}

class DefaultCommandRunner implements CommandRunner {
  run(command: string, args: string[], cwd?: string): string {
    return execFileSync(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).toString("utf8");
  }
}

function normalizeVersion(value: string): NormalizedVersion {
  const raw = String(value || "").trim();
  const match = raw.match(SEMVER_RE);
  if (!match) {
    throw new Error("version must be SemVer without build metadata, for example 0.2.0 or 1.0.0-rc.1");
  }

  const [, major, minor, patch, prereleaseLabel = ""] = match;
  const version = `${major}.${minor}.${patch}${prereleaseLabel ? `-${prereleaseLabel}` : ""}`;
  return {
    version,
    tag: `v${version}`,
    major: Number.parseInt(major, 10),
    prereleaseLabel,
  };
}

function parseBoolean(value: string, label: string, defaultValue: boolean): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be true or false`);
}

function resolvePrerelease(value: string, version: NormalizedVersion): boolean {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return version.major === 0 || Boolean(version.prereleaseLabel);
  }
  return parseBoolean(normalized, "prerelease", false);
}

function readPackageVersion(packageJsonPath: string): string {
  const raw = readFileSync(packageJsonPath, "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  return String(data.version || "").trim();
}

function commandSucceeds(runner: CommandRunner, command: string, args: string[], cwd?: string): boolean {
  try {
    runner.run(command, args, cwd);
    return true;
  } catch {
    return false;
  }
}

function gh(runner: CommandRunner, args: string[], cwd?: string): string {
  return runner.run("gh", args, cwd).trim();
}

function git(runner: CommandRunner, args: string[], cwd?: string): string {
  return runner.run("git", args, cwd).trim();
}

function parseGitObjectPointer(value: unknown, context: string): GitObjectPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub API response for ${context} did not include an object pointer`);
  }
  const record = value as Record<string, unknown>;
  const type = String(record.type || "").trim();
  const sha = String(record.sha || "").trim();
  if (!type || !sha) {
    throw new Error(`GitHub API response for ${context} did not include object type and SHA`);
  }
  return { type, sha };
}

function parseGitObjectResponse(raw: string, context: string): GitObjectPointer {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`GitHub API response for ${context} was not valid JSON`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`GitHub API response for ${context} was not an object`);
  }
  return parseGitObjectPointer((data as Record<string, unknown>).object, context);
}

function resolveGitObjectToCommitSha(
  runner: CommandRunner,
  repo: string,
  tag: string,
  object: GitObjectPointer,
  cwd?: string,
): string {
  let current = object;
  for (let depth = 0; depth < 5; depth += 1) {
    const type = current.type.toLowerCase();
    if (type === "commit") {
      return current.sha;
    }
    if (type !== "tag") {
      throw new Error(`Existing tag ${tag} points to ${current.type} object ${current.sha}, not a commit`);
    }
    const raw = gh(runner, ["api", `repos/${repo}/git/tags/${current.sha}`], cwd);
    current = parseGitObjectResponse(raw, `tag object ${current.sha}`);
  }
  throw new Error(`Existing tag ${tag} did not resolve to a commit`);
}

function existingTagCommitSha(runner: CommandRunner, repo: string, tag: string, cwd?: string): string | null {
  let raw: string;
  try {
    raw = gh(runner, ["api", `repos/${repo}/git/ref/tags/${tag}`], cwd);
  } catch {
    return null;
  }
  const object = parseGitObjectResponse(raw, `tag ref ${tag}`);
  return resolveGitObjectToCommitSha(runner, repo, tag, object, cwd);
}

function createAnnotatedTag(
  runner: CommandRunner,
  repo: string,
  tag: string,
  targetSha: string,
  version: string,
  cwd?: string,
): void {
  const tagObjectSha = gh(runner, [
    "api",
    "-X",
    "POST",
    `repos/${repo}/git/tags`,
    "-f",
    `tag=${tag}`,
    "-f",
    `message=Sepo ${version}`,
    "-f",
    `object=${targetSha}`,
    "-f",
    "type=commit",
    "--jq",
    ".sha",
  ], cwd);
  if (!tagObjectSha) {
    throw new Error(`GitHub API did not return a tag object SHA for ${tag}`);
  }

  gh(runner, [
    "api",
    "-X",
    "POST",
    `repos/${repo}/git/refs`,
    "-f",
    `ref=refs/tags/${tag}`,
    "-f",
    `sha=${tagObjectSha}`,
  ], cwd);
}

function releaseUrl(runner: CommandRunner, repo: string, tag: string, cwd?: string): string {
  return gh(runner, ["release", "view", tag, "--repo", repo, "--json", "url", "--jq", ".url"], cwd);
}

function releaseExists(runner: CommandRunner, repo: string, tag: string, cwd?: string): boolean {
  return commandSucceeds(
    runner,
    "gh",
    ["release", "view", tag, "--repo", repo, "--json", "url", "--jq", ".url"],
    cwd,
  );
}

function createRelease(
  runner: CommandRunner,
  repo: string,
  tag: string,
  targetSha: string,
  draft: boolean,
  prerelease: boolean,
  cwd?: string,
): void {
  const args = [
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--verify-tag",
    "--target",
    targetSha,
    "--title",
    `Sepo ${tag}`,
    "--generate-notes",
  ];
  if (draft) args.push("--draft");
  if (prerelease) args.push("--prerelease");
  gh(runner, args, cwd);
}

function updateRelease(
  runner: CommandRunner,
  repo: string,
  tag: string,
  targetSha: string,
  draft: boolean,
  prerelease: boolean,
  cwd?: string,
): void {
  gh(runner, [
    "release",
    "edit",
    tag,
    "--repo",
    repo,
    "--verify-tag",
    "--target",
    targetSha,
    "--title",
    `Sepo ${tag}`,
    `--draft=${String(draft)}`,
    `--prerelease=${String(prerelease)}`,
  ], cwd);
}

export function publishRelease(options: PublishReleaseOptions): PublishReleaseResult {
  const cwd = options.cwd || process.cwd();
  const runner = options.runner || new DefaultCommandRunner();
  const repo = String(options.repo || "").trim();
  if (repo !== SOURCE_REPOSITORY) {
    throw new Error(`release publishing is only allowed in ${SOURCE_REPOSITORY}`);
  }

  const normalizedVersion = normalizeVersion(options.version);
  const packageJsonPath = resolve(cwd, options.packageJsonPath || ".agent/package.json");
  const packageVersion = readPackageVersion(packageJsonPath);
  if (packageVersion !== normalizedVersion.version) {
    throw new Error(
      `.agent/package.json version ${packageVersion || "missing"} does not match ${normalizedVersion.version}`,
    );
  }

  const targetRef = String(options.targetRef || "main").trim() || "main";
  const targetSha = git(runner, ["rev-parse", "HEAD"], cwd);
  if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
    throw new Error(`could not resolve target commit SHA for ${targetRef}`);
  }

  const draft = parseBoolean(options.draft, "draft", true);
  const prerelease = resolvePrerelease(options.prerelease, normalizedVersion);
  const updateExisting = parseBoolean(options.updateExisting, "update_existing", false);

  const existingTagTargetSha = existingTagCommitSha(runner, repo, normalizedVersion.tag, cwd);
  if (existingTagTargetSha) {
    if (existingTagTargetSha.toLowerCase() !== targetSha.toLowerCase()) {
      throw new Error(
        `Existing tag ${normalizedVersion.tag} points to ${existingTagTargetSha}, not target ${targetSha}`,
      );
    }
  } else {
    createAnnotatedTag(
      runner,
      repo,
      normalizedVersion.tag,
      targetSha,
      normalizedVersion.version,
      cwd,
    );
  }

  const existingRelease = releaseExists(runner, repo, normalizedVersion.tag, cwd);
  let releaseAction: PublishReleaseResult["releaseAction"];
  if (existingRelease) {
    if (!updateExisting) {
      throw new Error(
        `GitHub Release ${normalizedVersion.tag} already exists; rerun with update_existing=true to update it`,
      );
    }
    updateRelease(runner, repo, normalizedVersion.tag, targetSha, draft, prerelease, cwd);
    releaseAction = "updated";
  } else {
    createRelease(runner, repo, normalizedVersion.tag, targetSha, draft, prerelease, cwd);
    releaseAction = "created";
  }

  const url = releaseUrl(runner, repo, normalizedVersion.tag, cwd);
  const result: PublishReleaseResult = {
    version: normalizedVersion.version,
    tag: normalizedVersion.tag,
    targetSha,
    draft,
    prerelease,
    tagCreated: existingTagTargetSha === null,
    releaseAction,
    releaseUrl: url,
  };

  setOutput("version", result.version);
  setOutput("tag", result.tag);
  setOutput("target_sha", result.targetSha);
  setOutput("draft", String(result.draft));
  setOutput("prerelease", String(result.prerelease));
  setOutput("tag_created", String(result.tagCreated));
  setOutput("release_action", result.releaseAction);
  setOutput("release_url", result.releaseUrl);

  return result;
}
