#!/usr/bin/env node
// CLI: run the optional setup manifest for a repository skill.
// Usage: node .agent/dist/cli/run-skill-setup.js [--skill <name>] [--skill-root <path>] [--repo-root <path>]
// Env: SKILL_NAME, SKILL_ROOT, GITHUB_WORKSPACE, SKILL_SETUP_TRUSTED_REF

import { parseArgs, type ParseArgsConfig } from "node:util";

import { setOutput } from "../output.js";
import { DEFAULT_SKILL_ROOT, runSkillSetup } from "../skills.js";

const USAGE = [
  "Usage: run-skill-setup.js [--skill <name>] [--skill-root <path>] [--repo-root <path>] [--trusted-ref <true|false>]",
  "",
  "Options:",
  "  --skill <name>             Skill name (defaults to SKILL_NAME)",
  "  --skill-root <path>        Skill root directory (defaults to SKILL_ROOT or .skills)",
  "  --repo-root <path>         Repository root (defaults to GITHUB_WORKSPACE or cwd)",
  "  --trusted-ref <true|false> Whether setup is loaded from a trusted checkout",
  "  -h, --help                Show this message",
  "",
].join("\n");

const ARG_CONFIG = {
  options: {
    skill: { type: "string" },
    "skill-root": { type: "string" },
    "repo-root": { type: "string" },
    "trusted-ref": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
  strict: true,
} as const satisfies ParseArgsConfig;

export interface RunSkillSetupArgs {
  skillName: string;
  skillRoot: string;
  repoRoot: string;
  trustedRef: boolean;
  help: boolean;
}

interface WritableLike { write(chunk: string): void; }

function parseBooleanFlag(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error("--trusted-ref must be true or false");
}

export function parseRunSkillSetupArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): RunSkillSetupArgs {
  const { values } = parseArgs({ ...ARG_CONFIG, args: argv });
  return {
    skillName: String(values.skill || env.SKILL_NAME || "").trim(),
    skillRoot: String(values["skill-root"] || env.SKILL_ROOT || DEFAULT_SKILL_ROOT).trim(),
    repoRoot: String(values["repo-root"] || env.GITHUB_WORKSPACE || process.cwd()).trim(),
    trustedRef: parseBooleanFlag(
      String(values["trusted-ref"] || env.SKILL_SETUP_TRUSTED_REF || ""),
    ),
    help: Boolean(values.help),
  };
}

export function runSkillSetupCli(
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

  let args: RunSkillSetupArgs;
  try {
    args = parseRunSkillSetupArgs(argv, env);
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
    const result = runSkillSetup({
      repoRoot: args.repoRoot,
      skillRoot: args.skillRoot,
      skillName: args.skillName,
      env,
      trustedRef: args.trustedRef,
    });
    setOutput("setup_exists", result.skill.setupExists ? "true" : "false");
    setOutput("setup_ran", result.setupRan ? "true" : "false");
    setOutput("step_count", String(result.stepCount));
    setOutput("setup_path", result.skill.setupPath);
    if (result.setupRan) {
      stdout.write(`Skill setup completed: ${result.skill.setupPath}\n`);
    } else {
      stdout.write(`No skill setup manifest found: ${result.skill.setupPath}\n`);
    }
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runSkillSetupCli(process.argv.slice(2));
}
