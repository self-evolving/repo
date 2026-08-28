import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gh } from "./github.js";
import { setOutput } from "./output.js";
import { parseReleaseVersion, type ReleaseVersion } from "./release-version.js";

export const RELEASE_PR_MARKER = "<!-- sepo-agent-release-pr -->";

const REQUIRED_RELEASE_FILES = [".agent/package.json", ".agent/CHANGELOG.md"];

export interface PublishReleaseOptions {
  repo: string;
  workspace: string;
  runnerTemp: string;
  versionInput?: string;
  targetShaInput?: string;
  prNumber?: string;
  dryRun?: boolean;
}

export interface PublishReleaseResult {
  conclusion: "published" | "dry-run" | "skipped";
  reason: string;
  version: string;
  tag: string;
  targetSha: string;
  releaseUrl: string;
  notesFile: string;
}

interface PackageJson {
  version?: unknown;
}

interface PullRequestFile {
  path?: unknown;
}

interface PullRequestView {
  body?: unknown;
  files?: PullRequestFile[];
  mergeCommit?: {
    oid?: unknown;
  } | null;
  mergedAt?: unknown;
  state?: unknown;
  title?: unknown;
  url?: unknown;
}

function commandErrorText(err: unknown): string {
  const record = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [record.message, record.stderr, record.stdout]
    .map((part) => {
      if (Buffer.isBuffer(part)) return part.toString("utf8");
      return typeof part === "string" ? part : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isNotFoundError(err: unknown): boolean {
  return /\b404\b|not found/i.test(commandErrorText(err));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    stdio: "pipe",
    maxBuffer: 1024 * 1024,
  }).toString("utf8");
}

function readTargetFile(workspace: string, targetSha: string, path: string): string {
  try {
    return git(workspace, ["show", `${targetSha}:${path}`]);
  } catch (err: unknown) {
    throw new Error(`${path} must exist at target SHA ${targetSha}: ${commandErrorText(err)}`);
  }
}

function readPackageVersion(workspace: string, targetSha: string): ReleaseVersion {
  const parsed = JSON.parse(readTargetFile(workspace, targetSha, ".agent/package.json")) as PackageJson;
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error(".agent/package.json must contain a version string");
  }
  return parseReleaseVersion(parsed.version);
}

export function extractChangelogNotes(changelog: string, version: string): string {
  const headingRe = new RegExp(`^##\\s+\\[?${escapeRegExp(version)}\\]?(?:\\s|$).*?$`, "m");
  const match = headingRe.exec(changelog);
  if (!match) {
    throw new Error(`.agent/CHANGELOG.md must contain a section for ${version}`);
  }

  const sectionStart = match.index + match[0].length;
  const rest = changelog.slice(sectionStart);
  const nextHeading = rest.search(/^##\s+/m);
  const section = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
  if (!section) {
    throw new Error(`.agent/CHANGELOG.md section for ${version} must contain release notes`);
  }
  return `${section}\n`;
}

function writeNotesFile(notes: string, runnerTemp: string, version: string): string {
  const file = join(runnerTemp || "/tmp", `release-notes-${version}-${randomBytes(8).toString("hex")}.md`);
  writeFileSync(file, notes, "utf8");
  return file;
}

function currentHead(workspace: string): string {
  return git(workspace, ["rev-parse", "HEAD"]).trim();
}

function ensureTargetShaReachableFromHead(workspace: string, targetSha: string): void {
  try {
    git(workspace, ["merge-base", "--is-ancestor", targetSha, "HEAD"]);
  } catch {
    throw new Error(`target SHA ${targetSha} is not reachable from the checked-out trusted HEAD`);
  }
}

function fetchPullRequest(repo: string, prNumber: string): PullRequestView {
  const raw = gh([
    "pr",
    "view",
    prNumber,
    "--repo",
    repo,
    "--json",
    "title,body,state,mergedAt,mergeCommit,files,url",
  ]);
  return JSON.parse(raw) as PullRequestView;
}

function changedFilePaths(pr: PullRequestView): Set<string> {
  return new Set((Array.isArray(pr.files) ? pr.files : []).map((file) => String(file.path || "")));
}

function validateReleasePr(repo: string, prNumber: string, targetSha: string): string | null {
  const pr = fetchPullRequest(repo, prNumber);
  if (String(pr.state || "").toUpperCase() !== "MERGED" || !String(pr.mergedAt || "").trim()) {
    return `PR #${prNumber} is not merged`;
  }

  const body = String(pr.body || "");
  if (!body.includes(RELEASE_PR_MARKER)) {
    return `PR #${prNumber} is not marked as a Sepo release PR`;
  }

  const paths = changedFilePaths(pr);
  const missing = REQUIRED_RELEASE_FILES.filter((path) => !paths.has(path));
  if (missing.length > 0) {
    return `PR #${prNumber} is missing required release file changes: ${missing.join(", ")}`;
  }

  const mergeOid = String(pr.mergeCommit?.oid || "").trim();
  if (mergeOid && targetSha && mergeOid !== targetSha) {
    throw new Error(`target SHA ${targetSha} does not match PR #${prNumber} merge commit ${mergeOid}`);
  }

  return null;
}

function ensureTagAbsent(repo: string, tag: string): void {
  try {
    gh(["api", `repos/${repo}/git/ref/tags/${tag}`]);
  } catch (err: unknown) {
    if (isNotFoundError(err)) return;
    throw new Error(`could not verify whether ${tag} already exists: ${commandErrorText(err)}`);
  }
  throw new Error(`release tag ${tag} already exists`);
}

function createRelease(repo: string, parsed: ReleaseVersion, targetSha: string, notesFile: string): string {
  const args = [
    "release",
    "create",
    parsed.tag,
    "--repo",
    repo,
    "--target",
    targetSha,
    "--title",
    parsed.tag,
    "--notes-file",
    notesFile,
  ];
  if (parsed.prereleaseLabel) args.push("--prerelease");
  return gh(args).trim();
}

function fallbackReleaseUrl(repo: string, tag: string): string {
  return `https://github.com/${repo}/releases/tag/${tag}`;
}

export function publishRelease(opts: PublishReleaseOptions): PublishReleaseResult {
  const repo = opts.repo.trim();
  if (!repo) throw new Error("Missing required env: GITHUB_REPOSITORY");

  const targetSha = (opts.targetShaInput || "").trim() || currentHead(opts.workspace);
  if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
    throw new Error(`target SHA must be a full 40-character commit SHA, got ${targetSha || "(empty)"}`);
  }
  ensureTargetShaReachableFromHead(opts.workspace, targetSha);

  const packageVersion = readPackageVersion(opts.workspace, targetSha);
  const requested = opts.versionInput?.trim() ? parseReleaseVersion(opts.versionInput).version : "";
  if (requested && requested !== packageVersion.version) {
    throw new Error(`requested version ${requested} does not match .agent/package.json version ${packageVersion.version}`);
  }

  if (opts.prNumber?.trim()) {
    const skipReason = validateReleasePr(repo, opts.prNumber.trim(), targetSha);
    if (skipReason) {
      return {
        conclusion: "skipped",
        reason: skipReason,
        version: packageVersion.version,
        tag: packageVersion.tag,
        targetSha,
        releaseUrl: "",
        notesFile: "",
      };
    }
  }

  const notes = extractChangelogNotes(
    readTargetFile(opts.workspace, targetSha, ".agent/CHANGELOG.md"),
    packageVersion.version,
  );
  const notesFile = writeNotesFile(notes, opts.runnerTemp, packageVersion.version);

  ensureTagAbsent(repo, packageVersion.tag);

  if (opts.dryRun) {
    return {
      conclusion: "dry-run",
      reason: `Would create ${packageVersion.tag} at ${targetSha}`,
      version: packageVersion.version,
      tag: packageVersion.tag,
      targetSha,
      releaseUrl: "",
      notesFile,
    };
  }

  const releaseUrl = createRelease(repo, packageVersion, targetSha, notesFile) || fallbackReleaseUrl(repo, packageVersion.tag);
  return {
    conclusion: "published",
    reason: `Created ${packageVersion.tag} at ${targetSha}`,
    version: packageVersion.version,
    tag: packageVersion.tag,
    targetSha,
    releaseUrl,
    notesFile,
  };
}

export function emitPublishReleaseResult(result: PublishReleaseResult): void {
  setOutput("conclusion", result.conclusion);
  setOutput("reason", result.reason);
  setOutput("version", result.version);
  setOutput("tag", result.tag);
  setOutput("target_sha", result.targetSha);
  setOutput("release_url", result.releaseUrl);
  setOutput("notes_file", result.notesFile);
  console.log(`${result.conclusion}: ${result.reason}`);
  if (result.releaseUrl) console.log(result.releaseUrl);
}
