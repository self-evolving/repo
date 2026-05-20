// CLI: preflight self-approval before running the approval agent.
// Env: GITHUB_REPOSITORY, TARGET_NUMBER, TARGET_KIND, REQUESTED_BY, WORKFLOW_ACTOR,
//      ORCHESTRATION_ENABLED,
//      AGENT_ALLOW_SELF_APPROVE, AGENT_ALLOW_SELF_MERGE, SOURCE_RECOMMENDED_NEXT_STEP
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
  evaluateSelfApprovalRequester,
  formatSelfApprovalBody,
  resolveTrustedSelfApprovalRequesters,
} from "../self-approval.js";

function normalizeToken(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

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
const targetKind = normalizeToken(process.env.TARGET_KIND || "pull_request");
const workflowActor = process.env.WORKFLOW_ACTOR || process.env.GITHUB_ACTOR || "";
const requestedByLogins = resolveTrustedSelfApprovalRequesters({
  requestedByLogin: process.env.REQUESTED_BY || "",
  workflowActorLogin: workflowActor,
  orchestrationEnabled: envFlagEnabled(process.env.ORCHESTRATION_ENABLED),
});
const allowSelfApprove = envFlagEnabled(process.env.AGENT_ALLOW_SELF_APPROVE);
const allowSelfMerge = envFlagEnabled(process.env.AGENT_ALLOW_SELF_MERGE);
const allowSameActorSelfApprove = allowSelfApprove && allowSelfMerge;
const sourceRecommendedNextStep = normalizeToken(process.env.SOURCE_RECOMMENDED_NEXT_STEP || "");
const isHumanDecisionGate = sourceRecommendedNextStep === "human_decision";
const isNoBranchWorkGate = sourceRecommendedNextStep === "no_automated_action";

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
  let prAuthorLogin = "";

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
      prAuthorLogin = fetchPrAuthorLogin(targetNumber, repo);
      for (const requestedByLogin of requestedByLogins.length ? requestedByLogins : [""]) {
        const requester = evaluateSelfApprovalRequester({
          requestedByLogin,
          prAuthorLogin,
        });
        if (!requester.allowed) {
          stop(requester.reason);
          shouldContinue = false;
          break;
        }
      }
    } catch {
      stop("could not verify self-approval requester during self-approval preflight");
      shouldContinue = false;
    }
  }

  if (shouldContinue) {
    try {
      authenticatedActorLogin = fetchAuthenticatedActorLogin();
      const approvalActor = evaluateSelfApprovalActor({
        approvalActorLogin: authenticatedActorLogin,
        prAuthorLogin,
        allowSameActor: allowSameActorSelfApprove,
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
        allowHumanDecisionGate: isHumanDecisionGate,
        allowNoBranchWorkGate: isNoBranchWorkGate,
      });
      if (!provenance.trusted) {
        stop(provenance.reason);
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
