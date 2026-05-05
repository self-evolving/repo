// CLI: apply an approved Sepo setup issue through allowlisted repo variables.
// Usage: node .agent/dist/cli/setup-apply.js
// Env: GITHUB_REPOSITORY, TARGET_NUMBER, SETUP_APPLY_DRY_RUN,
//      SETUP_APPLY_POST_COMMENT

import {
  applySetupVariablePlan,
  blockedSetupVariableResults,
  buildSetupVariablePlan,
  fetchRepoVariables,
  fetchSetupIssueBody,
  formatSetupApplyAudit,
  parseSetupIssueIntent,
  upsertSetupApplyComment,
} from "../setup-apply.js";

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isFalsey(value: string | undefined): boolean {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}

function parseTargetNumber(raw: string | undefined): number {
  const number = Number.parseInt(String(raw || ""), 10);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

const repo = String(process.env.GITHUB_REPOSITORY || "").trim();
const targetNumber = parseTargetNumber(process.env.TARGET_NUMBER);
const dryRun = isTruthy(process.env.SETUP_APPLY_DRY_RUN);
const postComment = !isFalsey(process.env.SETUP_APPLY_POST_COMMENT);

async function main(): Promise<void> {
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required.");
  }
  if (!targetNumber) {
    throw new Error("TARGET_NUMBER must be a positive issue number.");
  }

  const issueBody = fetchSetupIssueBody(repo, targetNumber);
  const intent = parseSetupIssueIntent(issueBody);
  const currentVariables = fetchRepoVariables(repo);
  const plan = buildSetupVariablePlan(intent, currentVariables);
  let audit = formatSetupApplyAudit({
    results: blockedSetupVariableResults(plan.changes),
    dryRun,
    errors: plan.errors,
    warnings: plan.warnings,
  });

  if (plan.errors.length > 0) {
    if (postComment) upsertSetupApplyComment(repo, targetNumber, audit);
    console.error(plan.errors.join("\n"));
    process.exitCode = 1;
    return;
  }

  const applyReport = applySetupVariablePlan(repo, plan.changes, dryRun);
  audit = formatSetupApplyAudit({
    results: applyReport.results,
    dryRun,
    errors: applyReport.errors,
    warnings: plan.warnings,
  });
  if (applyReport.errors.length > 0) {
    if (postComment) upsertSetupApplyComment(repo, targetNumber, audit);
    console.error(applyReport.errors.join("\n"));
    process.exitCode = 1;
    return;
  }

  if (postComment) upsertSetupApplyComment(repo, targetNumber, audit);
  console.log(audit);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const audit = formatSetupApplyAudit({
    changes: [],
    dryRun,
    errors: [message],
    warnings: [],
  });
  try {
    if (postComment && repo && targetNumber) {
      upsertSetupApplyComment(repo, targetNumber, audit);
    }
  } catch (postErr: unknown) {
    const postMessage = postErr instanceof Error ? postErr.message : String(postErr);
    console.error(`Could not post setup apply audit: ${postMessage}`);
  }
  console.error(message);
  process.exitCode = 1;
});
