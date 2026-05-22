import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { buildAuthUrl } from "./git.js";

export const DEFAULT_INSTALL_BRANCH = "agent/install-agent-infra";
export const INSTALL_PREPARE_STATE_FILE = "sepo-install-prepare-state.json";

const VALID_INSTALL_TARGET_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const DEFAULT_BOT_NAME = "sepo-agent";
const DEFAULT_BOT_EMAIL = "279869237+sepo-agent@users.noreply.github.com";
const MAX_BUFFER = 10 * 1024 * 1024;
const PREPARE_STATE_VERSION = 1;
const SEPO_APP_INSTALL_URL = "https://github.com/apps/sepo-agent-app/installations/select_target";
const SEPO_SETUP_GUIDE_URL = "https://github.com/self-evolving/repo/blob/main/.agent/docs/setup/setup-guide.md";
const REQUIRED_SETUP_HEADING = "## Required setup after merge";

export type InstallForkPrAction = "prepare" | "publish";
export type InstallForkPrStatus = "prepared" | "published" | "blocked";

export interface CommandRunner {
  gh(args: string[], opts?: { cwd?: string; input?: string }): string;
  git(args: string[], cwd: string, opts?: { input?: string }): string;
  sleep(ms: number): void;
}

export interface InstallForkPrResult {
  action: InstallForkPrAction;
  status: InstallForkPrStatus;
  targetRepo: string;
  defaultBranch: string;
  branch: string;
  tokenOwner: string;
  forkRepo: string;
  workdir: string;
  prUrl: string;
  prNumber: string;
  reusedPr: boolean;
  blockedCode: string;
  message: string;
}

export interface InstallForkPrOptions {
  targetRepo: string;
  githubToken: string;
  branch?: string;
  workdir?: string;
  runner?: CommandRunner;
  forkPollAttempts?: number;
}

export interface PublishInstallForkPrOptions extends InstallForkPrOptions {
  forkRepo?: string;
  defaultBranch?: string;
  title?: string;
  bodyFile?: string;
  sourceRequestUrl?: string;
}

interface RepoInfo {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  isFork: boolean;
  parentFullName: string;
  sourceFullName: string;
}

interface PullRequestInfo {
  number: string;
  url: string;
  headRefName: string;
  headOwner: string;
}

interface PrepareState {
  schemaVersion: number;
  targetRepo: string;
  defaultBranch: string;
  branch: string;
  tokenOwner: string;
  forkRepo: string;
}

class InstallForkPrBlocked extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallForkPrBlocked";
    this.code = code;
  }
}

export const defaultCommandRunner: CommandRunner = {
  gh(args, opts) {
    return execFileSync("gh", args, {
      cwd: opts?.cwd,
      input: opts?.input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
    }).toString("utf8");
  },
  git(args, cwd, opts) {
    return execFileSync("git", args, {
      cwd,
      input: opts?.input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
    }).toString("utf8");
  },
  sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

function emptyResult(action: InstallForkPrAction, opts: InstallForkPrOptions): InstallForkPrResult {
  return {
    action,
    status: "blocked",
    targetRepo: normalizeRepoSlug(opts.targetRepo),
    defaultBranch: "",
    branch: normalizeBranch(opts.branch),
    tokenOwner: "",
    forkRepo: "",
    workdir: opts.workdir || "",
    prUrl: "",
    prNumber: "",
    reusedPr: false,
    blockedCode: "",
    message: "",
  };
}

function blockedResult(
  action: InstallForkPrAction,
  opts: InstallForkPrOptions,
  err: InstallForkPrBlocked,
): InstallForkPrResult {
  return {
    ...emptyResult(action, opts),
    blockedCode: err.code,
    message: err.message,
  };
}

function normalizeRepoSlug(value: string): string {
  return String(value || "").trim();
}

function normalizeBranch(value: string | undefined): string {
  return String(value || DEFAULT_INSTALL_BRANCH).trim() || DEFAULT_INSTALL_BRANCH;
}

function normalizeLogin(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const login = (value as Record<string, unknown>).login;
  return typeof login === "string" ? login.trim() : "";
}

function parsePrNumber(url: string): string {
  const match = String(url || "").match(/\/pull\/(\d+)(?:[/?#].*)?$/);
  return match ? match[1] : "";
}

function normalizeSourceRequestUrl(value: string | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 4 || parts[2] !== "issues" || !/^\d+$/.test(parts[3])) return "";
    return `https://github.com/${parts.join("/")}`;
  } catch {
    return "";
  }
}

function githubRepoUrl(repo: string): string {
  const [owner = "", name = ""] = repo.trim().split("/");
  if (!owner || !name) return "";
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function markdownLink(label: string, url: string): string {
  return url ? `[${label}](${url})` : label;
}

function buildRequiredSetupSection(targetRepo: string): string {
  const repoUrl = githubRepoUrl(targetRepo);
  const secretsUrl = repoUrl ? `${repoUrl}/settings/secrets/actions` : "";
  const onboardingUrl = repoUrl ? `${repoUrl}/actions/workflows/agent-onboarding.yml` : "";
  const memoryUrl = repoUrl ? `${repoUrl}/actions/workflows/agent-memory-bootstrap.yml` : "";
  const rubricsUrl = repoUrl ? `${repoUrl}/actions/workflows/agent-rubrics-initialization.yml` : "";
  const setupIssueUrl = repoUrl ? `${repoUrl}/issues?q=is%3Aissue%20%22Sepo%20setup%20check%22` : "";

  return [
    REQUIRED_SETUP_HEADING,
    "",
    `1. ${markdownLink("Install the Sepo GitHub App on the target repository", SEPO_APP_INSTALL_URL)}, or choose another supported auth path from the ${markdownLink("setup guide", SEPO_SETUP_GUIDE_URL)}.`,
    `2. Add \`OPENAI_API_KEY\`, \`CLAUDE_CODE_OAUTH_TOKEN\`, and/or \`ANTHROPIC_API_KEY\` in ${markdownLink("Actions secrets", secretsUrl)}.`,
    `3. Run ${markdownLink("Agent / Onboarding / Check Setup", onboardingUrl)}.`,
    `4. Review the ${markdownLink("Sepo setup check issue", setupIssueUrl)} and complete remaining setup.`,
    `5. If needed, run ${markdownLink("Agent / Memory / Initialization", memoryUrl)} to create \`agent/memory\`.`,
    `6. Optionally run ${markdownLink("Agent / Rubrics / Initialization", rubricsUrl)} to create \`agent/rubrics\`.`,
  ].join("\n");
}

function isSecondLevelHeading(line: string): boolean {
  return /^##\s+\S/.test(line.trim());
}

function isRequiredSetupHeading(line: string): boolean {
  return line.trim().toLowerCase() === REQUIRED_SETUP_HEADING.toLowerCase();
}

function isSourceRequestLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("Source install request:") || trimmed.startsWith("<!-- sepo-install-source-request:");
}

function removeRequiredSetupSections(body: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!isRequiredSetupHeading(line)) {
      kept.push(line);
      index += 1;
      continue;
    }

    index += 1;
    while (
      index < lines.length &&
      !isSecondLevelHeading(lines[index]) &&
      !isSourceRequestLine(lines[index])
    ) {
      index += 1;
    }
  }

  while (kept.length > 0 && kept[kept.length - 1] === "") {
    kept.pop();
  }
  return kept;
}

function insertRequiredSetupSection(body: string, targetRepo: string): string {
  const lines = removeRequiredSetupSections(body);
  const section = buildRequiredSetupSection(targetRepo).split("\n");
  const summaryIndex = lines.findIndex((line) => line.trim().toLowerCase() === "## summary");

  if (summaryIndex < 0) {
    return [...section, "", ...lines].join("\n").trimEnd() + "\n";
  }

  const nextHeadingIndex = lines.findIndex((line, index) => index > summaryIndex && isSecondLevelHeading(line));
  const insertIndex = nextHeadingIndex < 0 ? lines.length : nextHeadingIndex;
  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);

  return [...before, "", ...section, "", ...after].join("\n").trimEnd() + "\n";
}

function ensureRequiredSetupInBodyFile(bodyFile: string, targetRepo: string): void {
  try {
    const currentBody = readFileSync(bodyFile, "utf8");
    const nextBody = insertRequiredSetupSection(currentBody, targetRepo);
    if (nextBody !== currentBody) {
      writeFileSync(bodyFile, nextBody, "utf8");
    }
  } catch {
    throw new InstallForkPrBlocked(
      "pr_body_update_failed",
      "Could not add required setup guidance to the install PR body.",
    );
  }
}

function ensureSourceRequestInBodyFile(bodyFile: string, sourceRequestUrl: string | undefined): void {
  const normalizedUrl = normalizeSourceRequestUrl(sourceRequestUrl);
  if (!normalizedUrl) return;

  try {
    const currentBody = readFileSync(bodyFile, "utf8");
    if (currentBody.includes(normalizedUrl)) return;
    const body = currentBody.endsWith("\n") ? currentBody : `${currentBody}\n`;
    writeFileSync(
      bodyFile,
      `${body}\nSource install request: ${normalizedUrl}\n<!-- sepo-install-source-request: ${normalizedUrl} -->\n`,
      "utf8",
    );
  } catch {
    throw new InstallForkPrBlocked(
      "pr_body_update_failed",
      "Could not add the source install request link to the install PR body.",
    );
  }
}

function parseJson(raw: string, description: string): unknown {
  try {
    return JSON.parse(String(raw || "{}"));
  } catch {
    throw new InstallForkPrBlocked(
      "invalid_github_response",
      `GitHub returned malformed JSON while reading ${description}.`,
    );
  }
}

function normalizeRepoInfo(raw: unknown): RepoInfo {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InstallForkPrBlocked("invalid_github_response", "GitHub returned an invalid repository payload.");
  }
  const record = raw as Record<string, unknown>;
  const fullName = String(record.full_name || record.nameWithOwner || "").trim();
  const [ownerFromFullName = "", nameFromFullName = ""] = fullName.split("/");
  const owner = normalizeLogin(record.owner) || ownerFromFullName;
  const name = String(record.name || nameFromFullName || "").trim();
  const parent = record.parent && typeof record.parent === "object"
    ? String((record.parent as Record<string, unknown>).full_name || "")
    : "";
  const source = record.source && typeof record.source === "object"
    ? String((record.source as Record<string, unknown>).full_name || "")
    : "";
  return {
    fullName: fullName || (owner && name ? `${owner}/${name}` : ""),
    owner,
    name,
    defaultBranch: String(record.default_branch || record.defaultBranchRef || "").trim(),
    isPrivate: Boolean(record.private),
    isFork: Boolean(record.fork),
    parentFullName: parent,
    sourceFullName: source,
  };
}

function normalizePullRequests(raw: string): PullRequestInfo[] {
  const parsed = parseJson(raw || "[]", "pull requests");
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry): PullRequestInfo | null => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const url = String(record.url || "").trim();
    const number = String(record.number || parsePrNumber(url));
    const headOwner = normalizeLogin(record.headRepositoryOwner);
    return {
      number,
      url,
      headRefName: String(record.headRefName || "").trim(),
      headOwner,
    };
  }).filter((pr): pr is PullRequestInfo => Boolean(pr?.url));
}

function sameLogin(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sameRepo(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function requireBasicInputs(opts: InstallForkPrOptions): { targetRepo: string; branch: string; runner: CommandRunner } {
  const targetRepo = normalizeRepoSlug(opts.targetRepo);
  if (!VALID_INSTALL_TARGET_REPO.test(targetRepo)) {
    throw new InstallForkPrBlocked(
      "invalid_target_repo",
      "Install target must be a repository slug in owner/repo form.",
    );
  }
  if (!String(opts.githubToken || "").trim()) {
    throw new InstallForkPrBlocked(
      "missing_token",
      "Install requires GH_TOKEN from AGENT_INSTALL_PAT.",
    );
  }
  return {
    targetRepo,
    branch: normalizeBranch(opts.branch),
    runner: opts.runner || defaultCommandRunner,
  };
}

function readAuthenticatedLogin(runner: CommandRunner): string {
  try {
    const login = runner.gh(["api", "user", "--jq", ".login"]).trim();
    if (login) return login;
  } catch {
    // Fall through to GraphQL viewer lookup for tokens where /user is limited.
  }

  try {
    const login = runner.gh([
      "api",
      "graphql",
      "-f",
      "query=query ViewerLogin { viewer { login } }",
      "--jq",
      ".data.viewer.login",
    ]).trim();
    if (login) return login;
  } catch {
    // handled below
  }

  throw new InstallForkPrBlocked(
    "authenticated_actor_unavailable",
    "Could not identify the AGENT_INSTALL_PAT token owner.",
  );
}

function readRepo(runner: CommandRunner, repo: string): RepoInfo {
  try {
    return normalizeRepoInfo(parseJson(runner.gh(["api", `repos/${repo}`]), `repository ${repo}`));
  } catch (err) {
    if (err instanceof InstallForkPrBlocked) throw err;
    throw new InstallForkPrBlocked(
      "target_unreadable",
      `Could not read ${repo}; ensure it exists and is public.`,
    );
  }
}

function tryReadRepo(runner: CommandRunner, repo: string): RepoInfo | null {
  try {
    return normalizeRepoInfo(parseJson(runner.gh(["api", `repos/${repo}`]), `repository ${repo}`));
  } catch {
    return null;
  }
}

function readPublicTargetRepo(runner: CommandRunner, targetRepo: string): RepoInfo {
  const repo = readRepo(runner, targetRepo);
  if (!repo.fullName || !repo.owner || !repo.name) {
    throw new InstallForkPrBlocked(
      "invalid_github_response",
      `GitHub returned incomplete repository metadata for ${targetRepo}.`,
    );
  }
  if (repo.isPrivate) {
    throw new InstallForkPrBlocked(
      "target_not_public",
      `Install target ${targetRepo} is not public; /install currently supports public repositories only.`,
    );
  }
  if (!repo.defaultBranch) {
    throw new InstallForkPrBlocked(
      "missing_default_branch",
      `Install target ${targetRepo} does not expose a default branch.`,
    );
  }
  return repo;
}

function listOpenInstallPrs(runner: CommandRunner, targetRepo: string, branch: string): PullRequestInfo[] {
  const raw = runner.gh([
    "pr",
    "list",
    "--repo",
    targetRepo,
    "--state",
    "open",
    "--head",
    branch,
    "--json",
    "number,url,headRefName,headRepositoryOwner",
  ]);
  return normalizePullRequests(raw).filter((pr) => pr.headRefName === branch);
}

function findReusablePr(prs: PullRequestInfo[], tokenOwner: string): PullRequestInfo | null {
  return prs.find((pr) => sameLogin(pr.headOwner, tokenOwner)) || null;
}

function findDuplicatePr(prs: PullRequestInfo[], tokenOwner: string): PullRequestInfo | null {
  return prs.find((pr) => pr.headOwner && !sameLogin(pr.headOwner, tokenOwner)) || null;
}

function ensureNoDuplicateInstallPr(prs: PullRequestInfo[], tokenOwner: string): PullRequestInfo | null {
  const duplicate = findDuplicatePr(prs, tokenOwner);
  if (duplicate) {
    throw new InstallForkPrBlocked(
      "duplicate_install_pr",
      `An open install PR already exists from ${duplicate.headOwner}:${duplicate.headRefName}: ${duplicate.url}`,
    );
  }
  return findReusablePr(prs, tokenOwner);
}

function repoIsForkOf(repo: RepoInfo, targetRepo: string): boolean {
  return sameRepo(repo.parentFullName, targetRepo) || sameRepo(repo.sourceFullName, targetRepo);
}

function prepareStatePath(runner: CommandRunner, workdir: string): string {
  try {
    const statePath = runner.git(["rev-parse", "--git-path", INSTALL_PREPARE_STATE_FILE], workdir).trim();
    if (statePath) return isAbsolute(statePath) ? statePath : join(workdir, statePath);
  } catch {
    // Fall back for tests or partial checkouts where git cannot resolve the path.
  }
  return join(workdir, ".git", INSTALL_PREPARE_STATE_FILE);
}

function writePrepareState(runner: CommandRunner, workdir: string, state: PrepareState): void {
  try {
    const statePath = prepareStatePath(runner, workdir);
    if (!existsSync(dirname(statePath))) {
      return;
    }
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    if (existsSync(workdir)) {
      throw new InstallForkPrBlocked(
        "prepare_state_write_failed",
        "Could not record install prepare state; rerun /install after checking the prepared checkout.",
      );
    }
  }
}

function normalizePrepareState(raw: unknown): PrepareState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InstallForkPrBlocked("invalid_prepare_state", "Install prepare state is not valid JSON.");
  }
  const record = raw as Record<string, unknown>;
  return {
    schemaVersion: Number(record.schemaVersion || 0),
    targetRepo: String(record.targetRepo || "").trim(),
    defaultBranch: String(record.defaultBranch || "").trim(),
    branch: String(record.branch || "").trim(),
    tokenOwner: String(record.tokenOwner || "").trim(),
    forkRepo: String(record.forkRepo || "").trim(),
  };
}

function readPrepareState(runner: CommandRunner, workdir: string): PrepareState {
  const statePath = prepareStatePath(runner, workdir);
  if (!existsSync(statePath)) {
    throw new InstallForkPrBlocked(
      "missing_prepare_state",
      "Publish requires the prepare-state file written by install-fork-pr prepare; rerun prepare and pass its returned workdir.",
    );
  }
  try {
    return normalizePrepareState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch (err) {
    if (err instanceof InstallForkPrBlocked) throw err;
    throw new InstallForkPrBlocked("invalid_prepare_state", "Install prepare state is not valid JSON.");
  }
}

function validatePrepareState(
  state: PrepareState,
  expected: { targetRepo: string; defaultBranch: string; branch: string; tokenOwner: string; forkRepo: string },
): void {
  if (state.schemaVersion !== PREPARE_STATE_VERSION) {
    throw new InstallForkPrBlocked(
      "invalid_prepare_state",
      "Install prepare state has an unsupported schema version; rerun prepare before publishing.",
    );
  }
  if (
    !sameRepo(state.targetRepo, expected.targetRepo) ||
    state.defaultBranch !== expected.defaultBranch ||
    state.branch !== expected.branch ||
    !sameLogin(state.tokenOwner, expected.tokenOwner) ||
    !sameRepo(state.forkRepo, expected.forkRepo)
  ) {
    throw new InstallForkPrBlocked(
      "prepare_state_mismatch",
      "Publish inputs do not match the prepared install worktree; rerun prepare and publish with its returned values.",
    );
  }
}

function validatePreparedBranch(runner: CommandRunner, workdir: string, branch: string): void {
  let currentBranch = "";
  try {
    currentBranch = runner.git(["symbolic-ref", "--quiet", "--short", "HEAD"], workdir).trim();
  } catch {
    throw new InstallForkPrBlocked(
      "workdir_branch_mismatch",
      `Publish requires the prepared install worktree to be on ${branch}, but HEAD is detached or unreadable; checkout the install branch or rerun prepare.`,
    );
  }
  if (currentBranch !== branch) {
    throw new InstallForkPrBlocked(
      "workdir_branch_mismatch",
      `Publish requires the prepared install worktree to be on ${branch}, but it is on ${currentBranch || "an unknown branch"}; checkout the install branch or rerun prepare.`,
    );
  }
}

function remoteBranchExists(runner: CommandRunner, repo: RepoInfo, branch: string): boolean {
  try {
    return Boolean(runner.git(["ls-remote", "--heads", `https://github.com/${repo.fullName}.git`, branch], process.cwd()).trim());
  } catch {
    return false;
  }
}

function ensureForkRepo(
  runner: CommandRunner,
  target: RepoInfo,
  tokenOwner: string,
  attempts: number,
): RepoInfo {
  if (sameLogin(tokenOwner, target.owner)) {
    return target;
  }

  const forkSlug = `${tokenOwner}/${target.name}`;
  const existing = tryReadRepo(runner, forkSlug);
  if (existing) {
    if (repoIsForkOf(existing, target.fullName)) return existing;
    throw new InstallForkPrBlocked(
      "fork_name_occupied",
      `The token owner already has ${forkSlug}, but it is not a fork of ${target.fullName}.`,
    );
  }

  let createdForkSlug = forkSlug;
  try {
    const created = normalizeRepoInfo(parseJson(
      runner.gh([
        "api",
        "--method",
        "POST",
        `repos/${target.fullName}/forks`,
        "-F",
        "default_branch_only=true",
      ]),
      `fork creation for ${target.fullName}`,
    ));
    if (created.fullName) createdForkSlug = created.fullName;
  } catch (err) {
    if (err instanceof InstallForkPrBlocked) throw err;
    throw new InstallForkPrBlocked(
      "fork_create_failed",
      `Could not create a fork of ${target.fullName} under ${tokenOwner}.`,
    );
  }

  const maxAttempts = Math.max(1, attempts);
  for (let i = 0; i < maxAttempts; i += 1) {
    const fork = tryReadRepo(runner, createdForkSlug) || tryReadRepo(runner, forkSlug);
    if (fork && repoIsForkOf(fork, target.fullName)) return fork;
    if (i < maxAttempts - 1) runner.sleep(2000);
  }

  throw new InstallForkPrBlocked(
    "fork_create_failed",
    `Fork ${createdForkSlug} was created but was not readable yet.`,
  );
}

function cloneTarget(
  runner: CommandRunner,
  target: RepoInfo,
  fork: RepoInfo,
  branch: string,
  checkoutExistingBranch: boolean,
  requestedWorkdir: string | undefined,
): string {
  const workdir = requestedWorkdir || join(mkdtempSync(join(tmpdir(), "sepo-install-")), target.name);
  try {
    const cloneArgs = checkoutExistingBranch
      ? [
          "clone",
          "--branch",
          target.defaultBranch,
          `https://github.com/${target.fullName}.git`,
          workdir,
        ]
      : [
          "clone",
          "--depth",
          "1",
          "--branch",
          target.defaultBranch,
          `https://github.com/${target.fullName}.git`,
          workdir,
        ];
    runner.git(cloneArgs, process.cwd());
    const targetDefaultRef = "sepo-target-default";
    runner.git(["branch", targetDefaultRef, "HEAD"], workdir);
    try {
      runner.git(["remote", "remove", "install-fork"], workdir);
    } catch {
      // Fresh clones will not have this remote.
    }
    runner.git(["remote", "add", "install-fork", `https://github.com/${fork.fullName}.git`], workdir);
    runner.git(["config", "user.name", process.env.GIT_BOT_NAME || DEFAULT_BOT_NAME], workdir);
    runner.git(["config", "user.email", process.env.GIT_BOT_EMAIL || DEFAULT_BOT_EMAIL], workdir);
    if (checkoutExistingBranch) {
      runner.git(["fetch", "install-fork", branch], workdir);
      runner.git(["checkout", "-B", branch, "FETCH_HEAD"], workdir);
      try {
        runner.git(["merge", "--no-edit", targetDefaultRef], workdir);
      } catch {
        throw new InstallForkPrBlocked(
          "target_default_merge_conflict",
          `Existing install branch ${fork.fullName}:${branch} conflicts with current ${target.fullName}:${target.defaultBranch}; resolve or close the install PR branch before rerunning /install.`,
        );
      }
    } else {
      runner.git(["checkout", "-B", branch], workdir);
    }
  } catch (err) {
    if (err instanceof InstallForkPrBlocked) throw err;
    throw new InstallForkPrBlocked(
      "target_clone_failed",
      `Could not clone ${target.fullName} and prepare ${branch}.`,
    );
  }
  return workdir;
}

export function prepareInstallForkPr(opts: InstallForkPrOptions): InstallForkPrResult {
  try {
    const { targetRepo, branch, runner } = requireBasicInputs(opts);
    const tokenOwner = readAuthenticatedLogin(runner);
    const target = readPublicTargetRepo(runner, targetRepo);
    const existingPr = ensureNoDuplicateInstallPr(
      listOpenInstallPrs(runner, target.fullName, branch),
      tokenOwner,
    );
    const fork = ensureForkRepo(runner, target, tokenOwner, opts.forkPollAttempts || 6);
    const existingForkBranch = Boolean(existingPr) || remoteBranchExists(runner, fork, branch);
    const workdir = cloneTarget(runner, target, fork, branch, existingForkBranch, opts.workdir);
    writePrepareState(runner, workdir, {
      schemaVersion: PREPARE_STATE_VERSION,
      targetRepo: target.fullName,
      defaultBranch: target.defaultBranch,
      branch,
      tokenOwner,
      forkRepo: fork.fullName,
    });

    return {
      action: "prepare",
      status: "prepared",
      targetRepo: target.fullName,
      defaultBranch: target.defaultBranch,
      branch,
      tokenOwner,
      forkRepo: fork.fullName,
      workdir,
      prUrl: existingPr?.url || "",
      prNumber: existingPr?.number || "",
      reusedPr: Boolean(existingPr),
      blockedCode: "",
      message: existingPr
        ? `Prepared ${workdir}; existing install PR will be reused: ${existingPr.url}`
        : `Prepared ${workdir}; fork ${fork.fullName} is ready for ${branch}.`,
    };
  } catch (err) {
    if (err instanceof InstallForkPrBlocked) return blockedResult("prepare", opts, err);
    throw err;
  }
}

function requirePublishInputs(opts: PublishInstallForkPrOptions): {
  targetRepo: string;
  branch: string;
  runner: CommandRunner;
  workdir: string;
  title: string;
  bodyFile: string;
} {
  const basic = requireBasicInputs(opts);
  const workdir = String(opts.workdir || "").trim();
  if (!workdir || !existsSync(workdir)) {
    throw new InstallForkPrBlocked(
      "missing_workdir",
      "Publish requires INSTALL_WORKDIR pointing at the prepared target checkout.",
    );
  }
  const title = String(opts.title || "Install Sepo agent infrastructure").trim();
  const bodyFile = String(opts.bodyFile || "").trim();
  if (!bodyFile || !existsSync(bodyFile)) {
    throw new InstallForkPrBlocked(
      "missing_pr_body",
      "Publish requires INSTALL_PR_BODY_FILE with the install PR body.",
    );
  }
  return { ...basic, workdir, title, bodyFile };
}

export function publishInstallForkPr(opts: PublishInstallForkPrOptions): InstallForkPrResult {
  try {
    const { targetRepo, branch, runner, workdir, title, bodyFile } = requirePublishInputs(opts);
    const tokenOwner = readAuthenticatedLogin(runner);
    const target = readPublicTargetRepo(runner, targetRepo);
    const defaultBranch = String(opts.defaultBranch || target.defaultBranch).trim() || target.defaultBranch;
    const existingPr = ensureNoDuplicateInstallPr(
      listOpenInstallPrs(runner, target.fullName, branch),
      tokenOwner,
    );
    const fork = opts.forkRepo
      ? readRepo(runner, opts.forkRepo)
      : ensureForkRepo(runner, target, tokenOwner, opts.forkPollAttempts || 6);
    if (!sameLogin(fork.owner, tokenOwner)) {
      throw new InstallForkPrBlocked(
        "fork_owner_mismatch",
        `Fork ${fork.fullName} is not owned by the AGENT_INSTALL_PAT token owner ${tokenOwner}.`,
      );
    }
    if (!sameRepo(fork.fullName, target.fullName) && !repoIsForkOf(fork, target.fullName)) {
      throw new InstallForkPrBlocked(
        "fork_not_related",
        `Fork ${fork.fullName} is not in the fork network for ${target.fullName}.`,
      );
    }
    validatePrepareState(readPrepareState(runner, workdir), {
      targetRepo: target.fullName,
      defaultBranch,
      branch,
      tokenOwner,
      forkRepo: fork.fullName,
    });
    validatePreparedBranch(runner, workdir, branch);
    ensureRequiredSetupInBodyFile(bodyFile, target.fullName);
    ensureSourceRequestInBodyFile(bodyFile, opts.sourceRequestUrl);

    try {
      runner.git(["push", buildAuthUrl(opts.githubToken, fork.fullName), `HEAD:${branch}`], workdir);
    } catch {
      throw new InstallForkPrBlocked(
        "push_failed",
        `Could not push ${branch} to ${fork.fullName}; check AGENT_INSTALL_PAT contents/write permissions.`,
      );
    }

    if (existingPr) {
      try {
        runner.gh([
          "pr",
          "edit",
          existingPr.number || existingPr.url,
          "--repo",
          target.fullName,
          "--body-file",
          bodyFile,
        ]);
      } catch {
        throw new InstallForkPrBlocked(
          "pr_update_failed",
          `Updated ${fork.fullName}:${branch}, but could not update install PR ${existingPr.url}; check AGENT_INSTALL_PAT pull-request permissions.`,
        );
      }

      return {
        action: "publish",
        status: "published",
        targetRepo: target.fullName,
        defaultBranch,
        branch,
        tokenOwner,
        forkRepo: fork.fullName,
        workdir,
        prUrl: existingPr.url,
        prNumber: existingPr.number,
        reusedPr: true,
        blockedCode: "",
        message: `Updated ${fork.fullName}:${branch} and reused install PR ${existingPr.url}.`,
      };
    }

    let prUrl = "";
    try {
      prUrl = runner.gh([
        "pr",
        "create",
        "--repo",
        target.fullName,
        "--base",
        defaultBranch,
        "--head",
        `${tokenOwner}:${branch}`,
        "--title",
        title,
        "--body-file",
        bodyFile,
      ]).trim();
    } catch {
      throw new InstallForkPrBlocked(
        "pr_create_failed",
        `Could not open an install PR against ${target.fullName}; check AGENT_INSTALL_PAT pull-request permissions.`,
      );
    }

    return {
      action: "publish",
      status: "published",
      targetRepo: target.fullName,
      defaultBranch,
      branch,
      tokenOwner,
      forkRepo: fork.fullName,
      workdir,
      prUrl,
      prNumber: parsePrNumber(prUrl),
      reusedPr: false,
      blockedCode: "",
      message: `Opened install PR ${prUrl}.`,
    };
  } catch (err) {
    if (err instanceof InstallForkPrBlocked) return blockedResult("publish", opts, err);
    throw err;
  }
}
