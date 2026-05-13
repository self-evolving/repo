import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import YAML from "yaml";

export const DEFAULT_SKILL_ROOT = ".skills";
export const SKILL_FILE_NAME = "SKILL.md";
export const SKILL_SETUP_FILE_NAME = "skill-setup.yaml";
export const DEFAULT_SKILL_SETUP_TIMEOUT_MINUTES = 10;
export const MAX_SKILL_SETUP_TIMEOUT_MINUTES = 360;

const VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_SHELL = /^[A-Za-z0-9_./+-]+$/;

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

export interface SkillSetupStep {
  name: string;
  run: string;
  shell: string;
  env: Record<string, string>;
  timeoutMinutes: number;
}

export interface SkillSetupManifest {
  version: 1;
  env: Record<string, string>;
  steps: SkillSetupStep[];
}

export interface RunSkillSetupResult {
  skill: SkillPackage;
  setupRan: boolean;
  stepCount: number;
}

type SpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
    timeout: number;
    maxBuffer: number;
  },
) => SpawnSyncReturns<Buffer>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function toRepoPath(repoRoot: string, absolutePath: string): string {
  const rel = relative(repoRoot, absolutePath);
  return rel.split(sep).join("/");
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new Error(`${path} must not contain NUL bytes`);
  }
  return value;
}

function parseEnv(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }

  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!VALID_ENV_NAME.test(key)) {
      throw new Error(`${path}.${key} is not a valid environment variable name`);
    }
    if (typeof raw !== "string") {
      throw new Error(`${path}.${key} must be a string`);
    }
    if (raw.includes("\0")) {
      throw new Error(`${path}.${key} must not contain NUL bytes`);
    }
    env[key] = raw;
  }
  return env;
}

function parseTimeoutMinutes(value: unknown, path: string): number {
  if (value === undefined) return DEFAULT_SKILL_SETUP_TIMEOUT_MINUTES;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${path} must be an integer`);
  }
  if (value < 1 || value > MAX_SKILL_SETUP_TIMEOUT_MINUTES) {
    throw new Error(`${path} must be between 1 and ${MAX_SKILL_SETUP_TIMEOUT_MINUTES}`);
  }
  return value;
}

function shellArgs(shell: string, command: string): string[] {
  const shellName = shell.split(/[\\/]/).pop()?.toLowerCase() || shell.toLowerCase();
  if (shellName === "bash" || shellName === "zsh") {
    return ["-e", "-o", "pipefail", "-c", command];
  }
  if (shellName === "sh") {
    return ["-e", "-c", command];
  }
  if (shellName === "pwsh" || shellName === "powershell") {
    return ["-NoProfile", "-Command", command];
  }
  return ["-c", command];
}

function formatCommandFailure(step: SkillSetupStep, result: SpawnSyncReturns<Buffer>): string {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      return `Skill setup step "${step.name}" timed out after ${step.timeoutMinutes} minutes`;
    }
    return `Skill setup step "${step.name}" failed to start: ${result.error.message}`;
  }
  if (result.signal) {
    return `Skill setup step "${step.name}" stopped with signal ${result.signal}`;
  }
  return `Skill setup step "${step.name}" exited with status ${result.status ?? 1}`;
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

export function parseSkillSetupManifest(raw: string): SkillSetupManifest {
  const parsed = YAML.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("skill setup manifest must be a YAML object");
  }
  if (parsed.version !== 1) {
    throw new Error("skill setup manifest version must be 1");
  }

  const stepsRaw = parsed.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new Error("skill setup manifest steps must be a non-empty array");
  }

  return {
    version: 1,
    env: parseEnv(parsed.env, "env"),
    steps: stepsRaw.map((stepRaw, index) => {
      const path = `steps[${index}]`;
      if (!isRecord(stepRaw)) {
        throw new Error(`${path} must be an object`);
      }
      const shell = stepRaw.shell === undefined
        ? "bash"
        : nonEmptyString(stepRaw.shell, `${path}.shell`);
      if (!VALID_SHELL.test(shell)) {
        throw new Error(`${path}.shell must be a simple shell command name or path`);
      }
      return {
        name: nonEmptyString(stepRaw.name, `${path}.name`),
        run: nonEmptyString(stepRaw.run, `${path}.run`),
        shell,
        env: parseEnv(stepRaw.env, `${path}.env`),
        timeoutMinutes: parseTimeoutMinutes(stepRaw.timeout_minutes, `${path}.timeout_minutes`),
      };
    }),
  };
}

export function readSkillSetupManifest(path: string): SkillSetupManifest {
  try {
    return parseSkillSetupManifest(readFileSync(path, "utf8"));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${SKILL_SETUP_FILE_NAME}: ${message}`);
  }
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
    return { skill, setupRan: false, stepCount: 0 };
  }
  if (input.trustedRef === false) {
    throw new Error(
      `Refusing to run ${skill.setupPath} from an untrusted PR checkout`,
    );
  }

  const manifest = readSkillSetupManifest(skill.setupFile);
  const baseEnv = input.env || process.env;
  const spawn = input.spawn || spawnSync;

  for (const [index, step] of manifest.steps.entries()) {
    process.stdout.write(`skill setup ${index + 1}/${manifest.steps.length}: ${step.name}\n`);
    const result = spawn(step.shell, shellArgs(step.shell, step.run), {
      cwd: repoRoot,
      env: {
        ...baseEnv,
        ...manifest.env,
        ...step.env,
        SKILL_NAME: skill.skillName,
        SKILL_ROOT: skill.skillRoot,
        SKILL_DIR: skill.skillDir,
      },
      stdio: "inherit",
      timeout: step.timeoutMinutes * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 || result.signal) {
      throw new Error(formatCommandFailure(step, result));
    }
  }

  return { skill, setupRan: true, stepCount: manifest.steps.length };
}
