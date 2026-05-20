// CLI: prepare or publish the fork-backed install PR used by /install.
//
// Usage:
//   node .agent/dist/cli/install-fork-pr.js prepare --target-repo <owner/repo>
//   node .agent/dist/cli/install-fork-pr.js publish --target-repo <owner/repo> \
//     --workdir <path> --fork-repo <owner/repo> --pr-body-file <path>
//
// Env:
//   GH_TOKEN
//   INSTALL_TARGET_REPO, INSTALL_BRANCH, INSTALL_WORKDIR, INSTALL_FORK_REPO,
//   INSTALL_DEFAULT_BRANCH, INSTALL_PR_TITLE, INSTALL_PR_BODY_FILE,
//   INSTALL_SOURCE_REQUEST_URL as fallbacks

import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  type InstallForkPrResult,
  type InstallForkPrOptions,
  type PublishInstallForkPrOptions,
  prepareInstallForkPr,
  publishInstallForkPr,
} from "../install-fork-pr.js";
import { setOutput } from "../output.js";

const ARG_CONFIG = {
  options: {
    "target-repo": { type: "string" },
    branch: { type: "string" },
    workdir: { type: "string" },
    "fork-repo": { type: "string" },
    "default-branch": { type: "string" },
    "pr-title": { type: "string" },
    "pr-body-file": { type: "string" },
    "source-request-url": { type: "string" },
  },
  allowPositionals: true,
  strict: true,
} as const satisfies ParseArgsConfig;

export interface InstallForkPrCliInput {
  action: string;
  common: InstallForkPrOptions;
  publish: PublishInstallForkPrOptions;
}

function env(name: string, source: NodeJS.ProcessEnv = process.env): string {
  return String(source[name] || "").trim();
}

function argValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceRequestUrl(sourceEnv: NodeJS.ProcessEnv, valueMap: Record<string, unknown>): string | undefined {
  const explicit = argValue(valueMap["source-request-url"]) || env("INSTALL_SOURCE_REQUEST_URL", sourceEnv);
  if (explicit) return explicit;
  return env("TARGET_KIND", sourceEnv) === "issue" ? env("TARGET_URL", sourceEnv) || undefined : undefined;
}

export function parseInstallForkPrCliArgs(
  argv: string[],
  sourceEnv: NodeJS.ProcessEnv = process.env,
): InstallForkPrCliInput {
  const { values, positionals } = parseArgs({ ...ARG_CONFIG, args: argv });
  if (positionals.length > 1) {
    throw new Error("Usage: install-fork-pr.js [prepare|publish] [options]");
  }

  const valueMap = values as Record<string, unknown>;
  const action = String(positionals[0] || env("INSTALL_FORK_PR_ACTION", sourceEnv) || "prepare")
    .trim()
    .toLowerCase();
  const common: InstallForkPrOptions = {
    targetRepo: argValue(valueMap["target-repo"]) || env("INSTALL_TARGET_REPO", sourceEnv),
    githubToken: env("GH_TOKEN", sourceEnv),
    branch: argValue(valueMap.branch) || env("INSTALL_BRANCH", sourceEnv) || undefined,
    workdir: argValue(valueMap.workdir) || env("INSTALL_WORKDIR", sourceEnv) || undefined,
  };

  return {
    action,
    common,
    publish: {
      ...common,
      forkRepo: argValue(valueMap["fork-repo"]) || env("INSTALL_FORK_REPO", sourceEnv) || undefined,
      defaultBranch: argValue(valueMap["default-branch"]) || env("INSTALL_DEFAULT_BRANCH", sourceEnv) || undefined,
      title: argValue(valueMap["pr-title"]) || env("INSTALL_PR_TITLE", sourceEnv) || undefined,
      bodyFile: argValue(valueMap["pr-body-file"]) || env("INSTALL_PR_BODY_FILE", sourceEnv) || undefined,
      sourceRequestUrl: sourceRequestUrl(sourceEnv, valueMap),
    },
  };
}

function writeOutputs(result: InstallForkPrResult): void {
  setOutput("action", result.action);
  setOutput("status", result.status);
  setOutput("target_repo", result.targetRepo);
  setOutput("default_branch", result.defaultBranch);
  setOutput("branch", result.branch);
  setOutput("token_owner", result.tokenOwner);
  setOutput("fork_repo", result.forkRepo);
  setOutput("workdir", result.workdir);
  setOutput("pr_url", result.prUrl);
  setOutput("pr_number", result.prNumber);
  setOutput("reused_pr", result.reusedPr ? "true" : "false");
  setOutput("blocked_code", result.blockedCode);
  setOutput("message", result.message);
  setOutput("install_status", result.status);
  setOutput("install_pr_url", result.prUrl);
}

export function runInstallForkPrCli(argv: string[], sourceEnv: NodeJS.ProcessEnv = process.env): number {
  let input: InstallForkPrCliInput;
  try {
    input = parseInstallForkPrCliArgs(argv, sourceEnv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let result: InstallForkPrResult;
  if (input.action === "prepare") {
    result = prepareInstallForkPr(input.common);
  } else if (input.action === "publish") {
    result = publishInstallForkPr(input.publish);
  } else {
    console.error(`Unsupported install fork PR action: ${input.action}`);
    return 1;
  }

  writeOutputs(result);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) {
  process.exitCode = runInstallForkPrCli(process.argv.slice(2));
}
