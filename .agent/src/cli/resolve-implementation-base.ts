// CLI: resolve the base branch for agent-implement.yml.
// Env: BASE_BRANCH, BASE_PR, DEFAULT_BRANCH, GITHUB_REPOSITORY
// Outputs/env: base_branch/BASE_BRANCH

import {
  exportImplementationBase,
  resolveImplementationBase,
} from "../implementation-base.js";

try {
  const result = resolveImplementationBase({
    baseBranch: process.env.BASE_BRANCH,
    basePr: process.env.BASE_PR,
    defaultBranch: process.env.DEFAULT_BRANCH || "",
    repo: process.env.GITHUB_REPOSITORY || "",
  });
  exportImplementationBase(result);
  console.log(`Resolved implementation base branch ${result.baseBranch} from ${result.source}`);
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
