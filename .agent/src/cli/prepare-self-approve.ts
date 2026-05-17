// CLI: preflight self-approval before running the approval agent.
// Env: GITHUB_REPOSITORY, TARGET_NUMBER, TARGET_KIND, AGENT_ALLOW_SELF_APPROVE,
//      SOURCE_HANDOFF_CONTEXT
// Outputs: should_run, head_sha, reason, body_file

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchAuthenticatedActorLogin,
  fetchIssueCommentRecords,
  fetchPrAuthorLogin,
  fetchPrMeta,
} from "../github.js";
import { setOutput } from "../output.js";
import {
  envFlagEnabled,
  evaluateSelfApprovalActor,
  evaluateSelfApprovalProvenance,
  formatSelfApprovalBody,
} from "../self-approval.js";

function writeBodyFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sepo-self-approve-"));
  const file = join(dir, "body.md");
  writeFileSync(file, body, "utf8");
  return file;
}

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

const repo = process.env.GITHUB_REPOSITORY || "";
const targetNumber = Number(process.env.TARGET_NUMBER || process.env.PR_NUMBER || "");
const targetKind = String(process.env.TARGET_KIND || "pull_request").trim().toLowerCase();
const allowSelfApprove = envFlagEnabled(process.env.AGENT_ALLOW_SELF_APPROVE);
const sourceHandoffContext = String(process.env.SOURCE_HANDOFF_CONTEXT || "").trim();

if (!allowSelfApprove) {
  stop("AGENT_ALLOW_SELF_APPROVE is not enabled");
} else if (targetKind !== "pull_request") {
  stop("self-approval is only supported for pull requests");
} else if (!repo || !targetNumber) {
  stop("missing pull request target");
} else {
  let shouldContinue = true;
  let headSha = "";
  let authenticatedActorLogin = "";

  try {
    const meta = fetchPrMeta(targetNumber, repo);
    if (String(meta.state || "").trim().toUpperCase() !== "OPEN") {
      stop(`pull request is ${String(meta.state || "not open").toLowerCase()}`);
      shouldContinue = false;
    } else if (!meta.headOid) {
      stop("could not resolve pull request head SHA");
      shouldContinue = false;
    } else {
      headSha = meta.headOid;
    }
  } catch {
    stop("could not read pull request metadata during self-approval preflight");
    shouldContinue = false;
  }

  if (shouldContinue) {
    try {
      authenticatedActorLogin = fetchAuthenticatedActorLogin();
      const approvalActor = evaluateSelfApprovalActor({
        approvalActorLogin: authenticatedActorLogin,
        prAuthorLogin: fetchPrAuthorLogin(targetNumber, repo),
      });
      if (!approvalActor.allowed) {
        stop(approvalActor.reason);
        shouldContinue = false;
      }
    } catch {
      stop("could not verify approval actor during self-approval preflight");
      shouldContinue = false;
    }
  }

  if (shouldContinue) {
    try {
      const provenance = evaluateSelfApprovalProvenance({
        comments: fetchIssueCommentRecords(targetNumber, repo),
        trustedActorLogin: authenticatedActorLogin,
        expectedHeadSha: headSha,
      });
      if (!provenance.trusted) {
        if (sourceHandoffContext && provenance.currentHeadReviewed) {
          setOutput("should_run", "true");
          setOutput("head_sha", headSha);
          setOutput("reason", provenance.reason);
          setOutput("body_file", "");
        } else {
          stop(provenance.reason);
        }
      } else {
        setOutput("should_run", "true");
        setOutput("head_sha", headSha);
        setOutput("reason", "");
        setOutput("body_file", "");
      }
    } catch {
      stop("could not read trusted review synthesis during self-approval preflight");
    }
  }
}
