// CLI: extract portal event context from GitHub webhook payload.
// Usage: node .agent/dist/cli/extract-context.js
// Env: GITHUB_EVENT_PATH, GITHUB_EVENT_NAME, GITHUB_REPOSITORY, INPUT_MENTION,
//      INPUT_TRIGGER_KIND, INPUT_LABEL_NAME, INPUT_AUTHOR_ASSOCIATION
// Outputs: should_respond, association, body, source_kind, target_kind,
//          target_number, target_url, reaction_subject_id, response_kind,
//          source_comment_id, source_comment_url, review_comment_id,
//          discussion_node_id, reply_to_id, requested_by, requested_route, requested_skill

import { readFileSync } from "node:fs";
import { isKnownAuthorAssociation } from "../access-policy.js";
import { ghApi, ghApiOk } from "../github.js";
import { setOutput } from "../output.js";
import {
  DEFAULT_MENTION,
  extractEventContext,
  getAuthorAssociation,
  getRequestedBy,
  shouldSkipSender,
  shouldRespondToMention,
} from "../context.js";
import { isApprovalCommand } from "../approval.js";
import { resolveDiscussionReplyTo } from "../discussion.js";
import { extractRequestedRouteDecision, resolveRequestedLabel } from "../triage.js";

const eventPath = process.env.GITHUB_EVENT_PATH;
const eventName = process.env.GITHUB_EVENT_NAME || "";
const mention = process.env.INPUT_MENTION || DEFAULT_MENTION;
const triggerKind = String(process.env.INPUT_TRIGGER_KIND || "mention").trim().toLowerCase();
const labelName = process.env.INPUT_LABEL_NAME || "";
const authorAssociationOverride = process.env.INPUT_AUTHOR_ASSOCIATION || "";
const repository = process.env.GITHUB_REPOSITORY || "";
const ISSUE_ASSOCIATIONS_TRUSTED_WITHOUT_REFRESH = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

function hasOrgMembership(orgLogin: string, userLogin: string): boolean {
  const membershipState = ghApi([
    `orgs/${orgLogin}/memberships/${userLogin}`,
    "--jq",
    ".state // empty",
  ]).toLowerCase();
  if (membershipState === "active") {
    return true;
  }

  // Public membership endpoint returns 204 (empty body) on success, so use
  // ghApiOk rather than checking the body.
  return ghApiOk([`orgs/${orgLogin}/members/${userLogin}`]);
}

function hasRepositoryPermission(userLogin: string): boolean {
  if (!repository || !userLogin) {
    return false;
  }

  const permission = ghApi([
    `repos/${repository}/collaborators/${userLogin}/permission`,
    "--jq",
    ".permission // .role_name // empty",
  ]).toLowerCase();

  return Boolean(permission) && permission !== "none";
}

function hasRepositoryCollaborator(userLogin: string): boolean {
  const login = String(userLogin || "").trim();
  if (!repository || !login) {
    return false;
  }

  return ghApiOk([`repos/${repository}/collaborators/${login}`]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveLabelActorAssociation(payload: Record<string, any>): string {
  const override = String(authorAssociationOverride || "").trim().toUpperCase();
  if (override) {
    return override;
  }

  const senderLogin = String(payload.sender?.login || "").trim();
  const ownerLogin = String(payload.repository?.owner?.login || repository.split("/")[0] || "").trim();
  const ownerType = String(payload.repository?.owner?.type || "").trim().toLowerCase();
  if (!senderLogin) {
    return "NONE";
  }

  if (ownerType === "user" && senderLogin.toLowerCase() === ownerLogin.toLowerCase()) {
    return "OWNER";
  }

  if (ownerType === "organization" && ownerLogin && hasOrgMembership(ownerLogin, senderLogin)) {
    return "MEMBER";
  }

  if (hasRepositoryPermission(senderLogin)) {
    return "COLLABORATOR";
  }

  return "NONE";
}

function refreshIssueAssociation(
  association: string,
  issueNumber: string,
  issueAuthorLogin: string,
): string {
  const normalized = String(association || "").trim().toUpperCase();

  if (
    authorAssociationOverride ||
    eventName !== "issues" ||
    ISSUE_ASSOCIATIONS_TRUSTED_WITHOUT_REFRESH.has(normalized) ||
    !repository ||
    !issueNumber
  ) {
    return normalized || association;
  }

  const refreshed = ghApi([
    `repos/${repository}/issues/${issueNumber}`,
    "--jq",
    ".author_association // empty",
  ]).toUpperCase();
  const resolved = refreshed || normalized || association;
  if (ISSUE_ASSOCIATIONS_TRUSTED_WITHOUT_REFRESH.has(resolved)) {
    return resolved;
  }

  if (hasRepositoryCollaborator(issueAuthorLogin)) {
    return "COLLABORATOR";
  }

  return resolved;
}

if (!eventPath || !eventName) {
  console.error("Missing GITHUB_EVENT_PATH or GITHUB_EVENT_NAME");
  process.exitCode = 2;
} else {
  const payload = JSON.parse(readFileSync(eventPath, "utf8"));

  // Gate 1: skip bot-authored events
  if (shouldSkipSender(payload)) {
    setOutput("should_respond", "false");
    console.log("Skipping bot-authored event");
  } else {
    // Gate 2: check author association
    const association = triggerKind === "label"
      ? resolveLabelActorAssociation(payload)
      : refreshIssueAssociation(
        authorAssociationOverride || getAuthorAssociation(eventName, payload),
        String(payload.issue?.number || ""),
        String(payload.issue?.user?.login || ""),
      );
    if (!isKnownAuthorAssociation(association)) {
      setOutput("should_respond", "false");
      console.log(`Skipping unsupported sender association: ${association}`);
    } else {
      const ctx = extractEventContext(eventName, payload);

      // Gate 3: validate target number
      if (!ctx.targetNumber) {
        setOutput("should_respond", "false");
        console.log("No target number found");
      }
      // Gate 4: check for live mention when mention-triggered
      else if (triggerKind !== "label" && !shouldRespondToMention(eventName, payload, mention)) {
        setOutput("should_respond", "false");
        console.log("No live mention found");
      }
      // Gate 5: skip approval commands on mention triggers
      else if (triggerKind !== "label" && isApprovalCommand(ctx.body, mention)) {
        setOutput("should_respond", "false");
        console.log("Skipping approval command (handled by agent-approve)");
      } else {
        // Resolve discussion reply threading if needed
        let replyToId = "";
        if (ctx.discussionCommentNodeId) {
          try {
            replyToId = resolveDiscussionReplyTo(ctx.discussionCommentNodeId);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`Could not resolve discussion reply-to: ${msg}`);
          }
        }

        const requestedBy =
          (triggerKind === "label" ? payload.sender?.login : "") || getRequestedBy(eventName, payload);
        const requestedLabel = triggerKind === "label" ? resolveRequestedLabel(labelName) : null;
        const requestedMention = triggerKind === "label"
          ? { route: "", skill: "" }
          : extractRequestedRouteDecision(ctx.body, mention);
        const requestedRoute = requestedLabel?.route || requestedMention.route;
        const requestedSkill = requestedLabel?.skill || requestedMention.skill;

        if (triggerKind === "label" && !requestedLabel) {
          setOutput("should_respond", "false");
          console.log(`Ignoring unsupported agent label: ${labelName || "missing"}`);
        } else {
          setOutput("should_respond", "true");
          setOutput("association", association);
          setOutput("body", ctx.body);
          setOutput("source_kind", ctx.sourceKind);
          setOutput("target_kind", ctx.targetKind);
          setOutput("target_number", ctx.targetNumber);
          setOutput("target_url", ctx.targetUrl);
          setOutput("reaction_subject_id", ctx.reactionSubjectId);
          setOutput("response_kind", ctx.responseKind);
          setOutput("source_comment_id", ctx.sourceCommentId || "");
          setOutput("source_comment_url", ctx.sourceCommentUrl || "");
          setOutput("review_comment_id", ctx.reviewCommentId || "");
          setOutput("discussion_node_id", ctx.discussionNodeId || "");
          setOutput("reply_to_id", replyToId);
          setOutput("requested_by", requestedBy);
          setOutput("requested_route", requestedRoute);
          setOutput("requested_skill", requestedSkill);
        }
      }
    }
  }
}
