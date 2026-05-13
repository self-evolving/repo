#!/usr/bin/env node
// CLI: resolve a repository skill package and expose workflow-friendly paths.
// Usage: node .agent/dist/cli/resolve-skill.js [--skill <name>] [--skill-root <path>] [--repo-root <path>]
// Env: SKILL_NAME, SKILL_ROOT, GITHUB_WORKSPACE

import { parseArgs, type ParseArgsConfig } from "node:util";

import { setOutput } from "../output.js";
import { DEFAULT_SKILL_ROOT, resolveSkillPackage } from "../skills.js";

const USAGE = [
  "Usage: resolve-skill.js [--skill <name>] [--skill-root <path>] [--repo-root <path>]",
  "",
  "Options:",
  "  --skill <name>       Skill name (defaults to SKILL_NAME)",
  "  --skill-root <path>  Skill root directory (defaults to SKILL_ROOT or .skills)",
  "  --repo-root <path>   Repository root (defaults to GITHUB_WORKSPACE or cwd)",
  "  -h, --help          Show this message",
  "",
].join("\n");

const ARG_CONFIG = {
  options: {
    skill: { type: "string" },
    "skill-root": { type: "string" },
    "repo-root": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
  strict: true,
} as const satisfies ParseArgsConfig;

export interface ResolveSkillArgs {
  skillName: string;
  skillRoot: string;
  repoRoot: string;
  help: boolean;
}

interface WritableLike { write(chunk: string): void; }

export function parseResolveSkillArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ResolveSkillArgs {
  const { values } = parseArgs({ ...ARG_CONFIG, args: argv });
  return {
    skillName: String(values.skill || env.SKILL_NAME || "").trim(),
    skillRoot: String(values["skill-root"] || env.SKILL_ROOT || DEFAULT_SKILL_ROOT).trim(),
    repoRoot: String(values["repo-root"] || env.GITHUB_WORKSPACE || process.cwd()).trim(),
    help: Boolean(values.help),
  };
}

export function runResolveSkillCli(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    stdout?: WritableLike;
    stderr?: WritableLike;
  } = {},
): number {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  let args: ResolveSkillArgs;
  try {
    args = parseResolveSkillArgs(argv, env);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (!args.skillName) {
    stderr.write(`Missing skill name.\n\n${USAGE}`);
    return 2;
  }

  try {
    const skill = resolveSkillPackage({
      repoRoot: args.repoRoot,
      skillRoot: args.skillRoot,
      skillName: args.skillName,
    });
    setOutput("exists", skill.skillExists ? "true" : "false");
    setOutput("setup_exists", skill.setupExists ? "true" : "false");
    setOutput("skill_path", skill.skillPath);
    setOutput("setup_path", skill.setupPath);
    setOutput("skill_root", skill.skillRoot);
    stdout.write(
      skill.skillExists
        ? `Skill found: ${skill.skillPath}\n`
        : `Skill file not found: ${skill.skillPath}\n`,
    );
    if (skill.setupExists) {
      stdout.write(`Skill setup found: ${skill.setupPath}\n`);
    }
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${message}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = runResolveSkillCli(process.argv.slice(2));
}
