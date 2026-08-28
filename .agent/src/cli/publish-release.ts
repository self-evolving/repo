// CLI: publish a prepared Sepo release by creating the tag and GitHub Release.
// Usage: node .agent/dist/cli/publish-release.js
// Env: GITHUB_REPOSITORY, VERSION, TARGET_SHA, PR_NUMBER, DRY_RUN, RUNNER_TEMP
// Outputs: conclusion, reason, version, tag, target_sha, release_url, notes_file

import { appendFileSync } from "node:fs";
import { publishRelease, emitPublishReleaseResult } from "../release-publish.js";

function parseBoolean(value: string): boolean {
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function appendSummary(lines: string[]): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  appendFileSync(summaryFile, `${lines.join("\n")}\n`);
}

try {
  const result = publishRelease({
    repo: process.env.GITHUB_REPOSITORY || "",
    workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
    runnerTemp: process.env.RUNNER_TEMP || "/tmp",
    versionInput: process.env.VERSION || "",
    targetShaInput: process.env.TARGET_SHA || "",
    prNumber: process.env.PR_NUMBER || "",
    dryRun: parseBoolean(process.env.DRY_RUN || ""),
  });
  emitPublishReleaseResult(result);
  appendSummary([
    `Release publish: ${result.conclusion}`,
    `Version: ${result.version}`,
    `Tag: ${result.tag}`,
    `Target: ${result.targetSha}`,
    result.releaseUrl ? `Release: ${result.releaseUrl}` : `Reason: ${result.reason}`,
  ]);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
}
