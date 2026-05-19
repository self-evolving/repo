// CLI: build the deterministic lifecycle plan for the productized install route.
// Env: REQUEST_TEXT, INSTALL_BRANCH, SOURCE_REPO
// Outputs: status, target_repo, install_branch, source_repo, candidates, message, plan_json

import { buildInstallLifecyclePlan } from "../install-lifecycle.js";
import { setOutput } from "../output.js";

const requestText = process.argv.slice(2).join(" ") || process.env.REQUEST_TEXT || "";
const plan = buildInstallLifecyclePlan({
  requestText,
  installBranch: process.env.INSTALL_BRANCH || "",
  sourceRepo: process.env.SOURCE_REPO || "",
});
const output = {
  status: plan.status,
  target_repo: plan.targetRepo,
  install_branch: plan.installBranch,
  source_repo: plan.sourceRepo,
  candidates: plan.candidates,
  message: plan.message,
  steps: plan.steps,
};
const planJson = JSON.stringify(output);

setOutput("status", plan.status);
setOutput("target_repo", plan.targetRepo);
setOutput("install_branch", plan.installBranch);
setOutput("source_repo", plan.sourceRepo);
setOutput("candidates", plan.candidates.join("\n"));
setOutput("message", plan.message);
setOutput("plan_json", planJson);

console.log(JSON.stringify(output, null, 2));
