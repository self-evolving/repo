// CLI: prepare or publish the fork-backed install PR used by /install.
//
// Usage:
//   node .agent/dist/cli/install-fork-pr.js prepare
//   node .agent/dist/cli/install-fork-pr.js publish
//
// Env:
//   GH_TOKEN, INSTALL_TARGET_REPO
//   INSTALL_BRANCH, INSTALL_WORKDIR, INSTALL_FORK_REPO, INSTALL_DEFAULT_BRANCH
//   INSTALL_PR_TITLE, INSTALL_PR_BODY_FILE

import {
  type InstallForkPrResult,
  prepareInstallForkPr,
  publishInstallForkPr,
} from "../install-fork-pr.js";
import { setOutput } from "../output.js";

function env(name: string): string {
  return String(process.env[name] || "").trim();
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
}

function main(): void {
  const action = String(process.argv[2] || env("INSTALL_FORK_PR_ACTION") || "prepare").trim().toLowerCase();
  const common = {
    targetRepo: env("INSTALL_TARGET_REPO"),
    githubToken: env("GH_TOKEN") || env("GITHUB_TOKEN") || env("INPUT_GITHUB_TOKEN"),
    branch: env("INSTALL_BRANCH") || undefined,
    workdir: env("INSTALL_WORKDIR") || undefined,
  };

  let result: InstallForkPrResult;
  if (action === "prepare") {
    result = prepareInstallForkPr(common);
  } else if (action === "publish") {
    result = publishInstallForkPr({
      ...common,
      forkRepo: env("INSTALL_FORK_REPO") || undefined,
      defaultBranch: env("INSTALL_DEFAULT_BRANCH") || undefined,
      title: env("INSTALL_PR_TITLE") || undefined,
      bodyFile: env("INSTALL_PR_BODY_FILE") || undefined,
    });
  } else {
    throw new Error(`Unsupported install fork PR action: ${action}`);
  }

  writeOutputs(result);
  console.log(JSON.stringify(result, null, 2));
}

main();
