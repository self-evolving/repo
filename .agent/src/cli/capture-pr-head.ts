// CLI: capture the current PR head SHA for workflows that need a stable reviewed head.
// Env: GITHUB_REPOSITORY, TARGET_NUMBER
// Outputs: head_sha

import { fetchPrMeta } from "../github.js";
import { setOutput } from "../output.js";

const repo = process.env.GITHUB_REPOSITORY || "";
const targetNumber = Number(process.env.TARGET_NUMBER || process.env.PR_NUMBER || "");

function warningMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function captureReviewedHeadSha(): string {
  try {
    if (!repo || !Number.isFinite(targetNumber) || targetNumber <= 0) {
      throw new Error("missing pull request target");
    }

    const meta = fetchPrMeta(targetNumber, repo);
    if (!meta.headOid) {
      throw new Error("could not resolve pull request head SHA");
    }

    return meta.headOid;
  } catch (err: unknown) {
    console.warn(`Reviewed head capture skipped: ${warningMessage(err)}`);
    return "";
  }
}

setOutput("head_sha", captureReviewedHeadSha());
