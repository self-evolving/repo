// CLI: ensure first-run Sepo labels and create/update the setup issue.
// Usage: node .agent/dist/cli/onboarding-check.js
// Env: GITHUB_REPOSITORY, AUTH_MODE, AGENT_PROVIDER, AGENT_PROVIDER_REASON,
//      OPENAI_API_KEY_CONFIGURED, CLAUDE_CODE_OAUTH_TOKEN_CONFIGURED,
//      MEMORY_REF, RUBRICS_REF, RUN_URL

import { runOnboardingCheck } from "../onboarding.js";
import { setOutput } from "../output.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isTrue(name: string): boolean {
  return (process.env[name] || "").trim().toLowerCase() === "true";
}

const repo = requiredEnv("GITHUB_REPOSITORY");
const issueNumber = runOnboardingCheck({
  repo,
  authMode: process.env.AUTH_MODE || "",
  provider: process.env.AGENT_PROVIDER || "",
  providerReason: process.env.AGENT_PROVIDER_REASON || "",
  openaiConfigured: isTrue("OPENAI_API_KEY_CONFIGURED"),
  claudeConfigured: isTrue("CLAUDE_CODE_OAUTH_TOKEN_CONFIGURED"),
  memoryRef: process.env.MEMORY_REF || "agent/memory",
  rubricsRef: process.env.RUBRICS_REF || "agent/rubrics",
  runUrl: process.env.RUN_URL || "",
  runnerTemp: process.env.RUNNER_TEMP || "/tmp",
});

setOutput("issue_number", String(issueNumber));
console.log(`Sepo onboarding issue is #${issueNumber}.`);
