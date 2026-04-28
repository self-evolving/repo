// CLI: scan comments for pending approval requests.
// Usage: node .agent/dist/cli/resolve-approval.js
// Env: GITHUB_EVENT_PATH, GITHUB_EVENT_NAME, GITHUB_REPOSITORY,
//      INPUT_MENTION, ACCESS_POLICY, REPOSITORY_PRIVATE
// Outputs: should_dispatch, is_discussion, request_comment_id,
//          request_comment_body, route, target_kind, target_number,
//          target_url, workflow, issue_title, issue_body, request_text,
//          should_create_issue

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setOutput } from "../output.js";
import { DEFAULT_MENTION } from "../context.js";
import {
  type AccessPolicy,
  getAllowedAssociationsForRoute,
  isAssociationAllowedForRoute,
  isKnownAuthorAssociation,
  parseAccessPolicy,
} from "../access-policy.js";
import {
  isApprovalCommand,
  isAgentApprovalComment,
  findPendingRequestById,
  parseApprovalCommand,
  shouldCreateIssueFromApprovalRequest,
} from "../approval.js";
import { fetchDiscussionComments } from "../discussion.js";

const GH_API_MAX_BUFFER = 10 * 1024 * 1024;

interface Comment {
  id: string | number;
  body: string;
  created_at: string;
}

const eventPath = process.env.GITHUB_EVENT_PATH;
const eventName = process.env.GITHUB_EVENT_NAME || "";
const repo = process.env.GITHUB_REPOSITORY || "";
const mention = process.env.INPUT_MENTION || DEFAULT_MENTION;
const isPublicRepo = String(process.env.REPOSITORY_PRIVATE || "").trim().toLowerCase() === "false";

function loadAccessPolicy(): AccessPolicy | null {
  try {
    return parseAccessPolicy(process.env.ACCESS_POLICY || "");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid AGENT_ACCESS_POLICY: ${msg}`);
    return null;
  }
}

function fetchIssueComments(issueNumber: number | string): Comment[] {
  const raw = execFileSync(
    "gh",
    ["api", "--paginate", `repos/${repo}/issues/${issueNumber}/comments`],
    { stdio: ["pipe", "pipe", "pipe"], maxBuffer: GH_API_MAX_BUFFER },
  ).toString("utf8");

  const comments: Comment[] = [];
  // --paginate concatenates JSON arrays, so parse each array
  for (const chunk of raw.split(/(?<=\])\s*(?=\[)/)) {
    if (!chunk.trim()) continue;
    try {
      const arr = JSON.parse(chunk) as Array<{ id: number; body: string; created_at: string }>;
      for (const c of arr) {
        comments.push({
          id: String(c.id),
          body: c.body || "",
          created_at: c.created_at || "",
        });
      }
    } catch {
      /* skip malformed chunks */
    }
  }
  return comments;
}

function main(): void {
  if (!eventPath || !eventName || !repo) {
    console.error("Missing GITHUB_EVENT_PATH, GITHUB_EVENT_NAME, or GITHUB_REPOSITORY");
    setOutput("should_dispatch", "false");
    process.exitCode = 2;
    return;
  }

  const accessPolicy = loadAccessPolicy();
  if (!accessPolicy) {
    setOutput("should_dispatch", "false");
    process.exitCode = 2;
    return;
  }

  const payload = JSON.parse(readFileSync(eventPath, "utf8"));
  const commentBody = payload.comment?.body || "";

  // Skip agent-managed approval request/status comments before doing any heavier work.
  if (isAgentApprovalComment(commentBody)) {
    console.log("Skipping agent-managed approval comment");
    setOutput("should_dispatch", "false");
    return;
  }

  const association = payload.comment?.author_association || "NONE";
  if (!isKnownAuthorAssociation(association)) {
    console.log(`Skipping unsupported approval association: ${association}`);
    setOutput("should_dispatch", "false");
    return;
  }

  if (!isApprovalCommand(commentBody, mention)) {
    console.log("No valid approval command found");
    setOutput("should_dispatch", "false");
    return;
  }

  const approvalCommand = parseApprovalCommand(commentBody, mention);
  if (!approvalCommand) {
    console.log("Approval command is missing a request ID");
    setOutput("should_dispatch", "false");
    return;
  }

  const isDiscussion = eventName === "discussion_comment";
  let comments: Comment[];
  if (isDiscussion) {
    const [owner, repoName] = repo.split("/");
    comments = fetchDiscussionComments(owner, repoName, payload.discussion?.number);
  } else {
    comments = fetchIssueComments(payload.issue?.number);
  }

  const pending = findPendingRequestById(comments, approvalCommand.requestId);
  if (!pending) {
    console.log(`No pending agent approval request found for ${approvalCommand.requestId}`);
    setOutput("should_dispatch", "false");
    return;
  }

  const route = String(pending.request.route || "");
  if (!isAssociationAllowedForRoute(accessPolicy, route, association, isPublicRepo)) {
    const allowed = getAllowedAssociationsForRoute(accessPolicy, route, isPublicRepo);
    console.log(`Skipping unauthorized approval for route ${route || "default"} from ${association}; requires ${allowed.join(", ")}`);
    setOutput("should_dispatch", "false");
    return;
  }

  setOutput("should_dispatch", "true");
  setOutput("is_discussion", String(isDiscussion));
  setOutput("request_comment_id", String(pending.comment.id));
  setOutput("request_comment_body", pending.comment.body);
  setOutput("route", route);
  setOutput("target_kind", String(pending.request.target_kind || ""));
  setOutput("target_number", String(pending.request.target_number || ""));
  setOutput("target_url", String(pending.request.target_url || ""));
  setOutput("workflow", String(pending.request.workflow || ""));
  setOutput("issue_title", String(pending.request.issue_title || ""));
  setOutput("issue_body", String(pending.request.issue_body || ""));
  setOutput("request_text", String(pending.request.request_text || ""));
  setOutput(
    "should_create_issue",
    String(shouldCreateIssueFromApprovalRequest(pending.request)),
  );
}

main();
