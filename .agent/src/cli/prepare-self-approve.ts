// CLI: preflight self-approval before running the agent.
// Env: GITHUB_REPOSITORY, TARGET_NUMBER, TARGET_KIND, AGENT_ALLOW_SELF_APPROVE
// Outputs: should_run, head_sha, reason, body_file

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPrMeta } from "../github.js";
import { setOutput } from "../output.js";
import { envFlagEnabled, formatSelfApprovalBody } from "../self-approval.js";

function writeBodyFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sepo-self-approve-"));
  const file = join(dir, "body.md");
  writeFileSync(file, body, "utf8");
  return file;
}

const repo = process.env.GITHUB_REPOSITORY || "";
const targetNumber = Number(process.env.TARGET_NUMBER || process.env.PR_NUMBER || "");
const targetKind = String(process.env.TARGET_KIND || "pull_request").trim().toLowerCase();
const allowSelfApprove = envFlagEnabled(process.env.AGENT_ALLOW_SELF_APPROVE);

function stop(reason: string): void {
  const bodyFile = writeBodyFile(formatSelfApprovalBody({
    conclusion: "blocked",
    reason,
    approved: false,
  }));
  setOutput("should_run", "false");
  setOutput("head_sha", "");
  setOutput("reason", reason);
  setOutput("body_file", bodyFile);
}

if (!allowSelfApprove) {
  stop("AGENT_ALLOW_SELF_APPROVE is not enabled");
} else if (targetKind !== "pull_request") {
  stop("self-approval is only supported for pull requests");
} else if (!repo || !targetNumber) {
  stop("missing pull request target");
} else {
  try {
    const meta = fetchPrMeta(targetNumber, repo);
    if (String(meta.state || "").trim().toUpperCase() !== "OPEN") {
      stop(`pull request is ${String(meta.state || "not open").toLowerCase()}`);
    } else if (!meta.headOid) {
      stop("could not resolve pull request head SHA");
    } else {
      setOutput("should_run", "true");
      setOutput("head_sha", meta.headOid);
      setOutput("reason", "");
      setOutput("body_file", "");
    }
  } catch {
    stop("could not read pull request metadata");
  }
}
