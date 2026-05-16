import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const DEFAULT_SKILL_ROOT = ".skills";
export const SKILL_FILE_NAME = "SKILL.md";
export const SKILL_SETUP_FILE_NAME = "setup.sh";

const VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SkillPackage {
  skillName: string;
  skillRoot: string;
  skillDir: string;
  skillFile: string;
  setupFile: string;
  skillPath: string;
  setupPath: string;
  skillExists: boolean;
  setupExists: boolean;
}

export interface RunSkillSetupResult {
  skill: SkillPackage;
  setupRan: boolean;
}

type SpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  },
) => SpawnSyncReturns<Buffer>;

function isInsideOrEqual(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function toRepoPath(repoRoot: string, absolutePath: string): string {
  const rel = relative(repoRoot, absolutePath);
  return rel.split(sep).join("/");
}

export function normalizeSkillName(skillName: string): string {
  const normalized = skillName.trim();
  if (!VALID_SKILL_NAME.test(normalized)) {
    throw new Error(
      `Invalid skill name "${skillName}". Use letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return normalized;
}

export function resolveSkillPackage(input: {
  repoRoot?: string;
  skillRoot?: string;
  skillName: string;
}): SkillPackage {
  const repoRoot = resolve(input.repoRoot || process.cwd());
  const skillRootInput = (input.skillRoot || DEFAULT_SKILL_ROOT).trim() || DEFAULT_SKILL_ROOT;
  if (skillRootInput.includes("\0")) {
    throw new Error("skill root must not contain NUL bytes");
  }

  const skillName = normalizeSkillName(input.skillName);
  const skillRoot = resolve(repoRoot, skillRootInput);
  if (!isInsideOrEqual(skillRoot, repoRoot)) {
    throw new Error(`Skill root must stay inside the repository: ${skillRootInput}`);
  }

  const skillDir = resolve(skillRoot, skillName);
  if (!isInsideOrEqual(skillDir, skillRoot)) {
    throw new Error(`Skill directory must stay inside the skill root: ${skillName}`);
  }

  const skillFile = join(skillDir, SKILL_FILE_NAME);
  const setupFile = join(skillDir, SKILL_SETUP_FILE_NAME);
  return {
    skillName,
    skillRoot,
    skillDir,
    skillFile,
    setupFile,
    skillPath: toRepoPath(repoRoot, skillFile),
    setupPath: toRepoPath(repoRoot, setupFile),
    skillExists: existsSync(skillFile),
    setupExists: existsSync(setupFile),
  };
}

function formatCommandFailure(result: SpawnSyncReturns<Buffer>): string {
  if (result.error) {
    return `Skill setup failed to start: ${result.error.message}`;
  }
  if (result.signal) {
    return `Skill setup stopped with signal ${result.signal}`;
  }
  return `Skill setup exited with status ${result.status ?? 1}`;
}

export function runSkillSetup(input: {
  repoRoot?: string;
  skillRoot?: string;
  skillName: string;
  env?: NodeJS.ProcessEnv;
  trustedRef?: boolean;
  spawn?: SpawnLike;
}): RunSkillSetupResult {
  const repoRoot = resolve(input.repoRoot || process.cwd());
  const skill = resolveSkillPackage({
    repoRoot,
    skillRoot: input.skillRoot,
    skillName: input.skillName,
  });
  if (!skill.skillExists) {
    throw new Error(`Skill file not found: ${skill.skillPath}`);
  }
  if (!skill.setupExists) {
    return { skill, setupRan: false };
  }
  if (input.trustedRef === false) {
    throw new Error(`Refusing to run ${skill.setupPath} from an untrusted PR checkout`);
  }

  const spawn = input.spawn || spawnSync;
  const result = spawn("bash", [skill.setupFile], {
    cwd: repoRoot,
    env: {
      ...(input.env || process.env),
      SKILL_NAME: skill.skillName,
      SKILL_ROOT: skill.skillRoot,
      SKILL_DIR: skill.skillDir,
    },
    stdio: "inherit",
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(formatCommandFailure(result));
  }

  return { skill, setupRan: true };
}
