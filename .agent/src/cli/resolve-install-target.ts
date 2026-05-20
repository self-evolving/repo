// CLI: resolve the target repository for the productized install route.
// Env: REQUEST_TEXT
// Outputs: status, target_repo, candidates, message

import { resolveInstallTargetFromText } from "../install-target.js";
import { setOutput } from "../output.js";

const requestText = process.argv.slice(2).join(" ") || process.env.REQUEST_TEXT || "";
const result = resolveInstallTargetFromText(requestText);

setOutput("status", result.status);
setOutput("target_repo", result.targetRepo);
setOutput("candidates", result.candidates.join("\n"));
setOutput("message", result.message);

console.log(JSON.stringify({
  status: result.status,
  target_repo: result.targetRepo,
  candidates: result.candidates,
  message: result.message,
}));
