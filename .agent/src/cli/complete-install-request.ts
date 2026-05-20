// CLI: close an issue-backed /install request after the target install PR is ready.
// Usage: node .agent/dist/cli/complete-install-request.js
// Env: GITHUB_REPOSITORY, TARGET_KIND, TARGET_NUMBER, INSTALL_STATUS, INSTALL_PR_URL

import {
  completeInstallRequest,
  type CompleteInstallRequestResult,
} from "../install-request.js";
import { setOutput } from "../output.js";

function env(name: string, source: NodeJS.ProcessEnv = process.env): string {
  return String(source[name] || "").trim();
}

export interface CompleteInstallRequestCliInput {
  sourceRepo: string;
  targetKind: string;
  targetNumber: string;
  installStatus: string;
  prUrl: string;
}

export function readCompleteInstallRequestCliInput(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): CompleteInstallRequestCliInput {
  return {
    sourceRepo: env("GITHUB_REPOSITORY", sourceEnv),
    targetKind: env("TARGET_KIND", sourceEnv),
    targetNumber: env("TARGET_NUMBER", sourceEnv),
    installStatus: env("INSTALL_STATUS", sourceEnv),
    prUrl: env("INSTALL_PR_URL", sourceEnv),
  };
}

function writeOutputs(result: CompleteInstallRequestResult): void {
  setOutput("install_request_completion_status", result.status);
  setOutput("install_request_completion_reason", result.reason);
  setOutput("install_request_completion_message", result.message);
  setOutput("install_request_pr_url", result.prUrl);
  setOutput("install_request_issue_number", result.issueNumber);
}

export function runCompleteInstallRequestCli(sourceEnv: NodeJS.ProcessEnv = process.env): number {
  const input = readCompleteInstallRequestCliInput(sourceEnv);
  const result = completeInstallRequest(input);
  writeOutputs(result);
  console.log(JSON.stringify(result, null, 2));
  return result.status === "failed" ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = runCompleteInstallRequestCli();
}
