// CLI: dispatch onboarding after GitHub App installation, or create a fallback setup issue.
// Usage: node .agent/dist/cli/installation-bootstrap.js
// Env: GITHUB_REPOSITORY, DEFAULT_BRANCH, INSTALLATION_ID, RUN_URL

import { runInstallationBootstrap } from "../installation-bootstrap.js";
import { setOutput } from "../output.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const result = runInstallationBootstrap({
  repo: requiredEnv("GITHUB_REPOSITORY"),
  ref: process.env.DEFAULT_BRANCH || "main",
  installationId: process.env.INSTALLATION_ID || "",
  runUrl: process.env.RUN_URL || "",
  runnerTemp: process.env.RUNNER_TEMP || "/tmp",
});

setOutput("status", result.status);
setOutput("issue_number", result.issueNumber === null ? "" : String(result.issueNumber));
console.log(
  result.issueNumber === null
    ? `Sepo installation bootstrap ${result.status}.`
    : `Sepo installation bootstrap ${result.status}; setup issue is #${result.issueNumber}.`,
);
