// CLI: apply dispatch policy to agent triage output.
// Usage: node .agent/dist/cli/resolve-dispatch.js
// Env: RESPONSE_FILE, TARGET_KIND, AUTHOR_ASSOCIATION, REQUESTED_ROUTE, REQUEST_TEXT,
//      REQUESTED_SKILL, ACCESS_POLICY, REPOSITORY_PRIVATE
// Outputs: route, needs_approval, confidence, summary, issue_title, issue_body,
//          skill

import { readFileSync } from "node:fs";
import { type AccessPolicy, parseAccessPolicy } from "../access-policy.js";
import { setOutput } from "../output.js";
import {
  normalizeDispatch,
  applyDispatchPolicy,
  buildRequestedRouteDecision,
} from "../triage.js";

const responseFile = process.env.RESPONSE_FILE || "";
const targetKind = process.env.TARGET_KIND || "";
const authorAssociation = process.env.AUTHOR_ASSOCIATION || "";
const requestedRoute = String(process.env.REQUESTED_ROUTE || "").trim().toLowerCase();
const requestedSkill = String(process.env.REQUESTED_SKILL || "").trim();
const requestText = process.env.REQUEST_TEXT || "";
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

function emitDecision(accessPolicy: AccessPolicy): void {
  try {
    const isExplicit = Boolean(requestedRoute);
    const decision = isExplicit
      ? buildRequestedRouteDecision(requestedRoute, requestText)
      : normalizeDispatch(raw);
    const result = applyDispatchPolicy(
      decision,
      targetKind,
      authorAssociation,
      accessPolicy,
      isPublicRepo,
      isExplicit,
    );

    setOutput("route", result.route);
    setOutput("needs_approval", String(result.needsApproval));
    setOutput("confidence", result.confidence);
    setOutput("summary", result.summary);
    setOutput("issue_title", result.issueTitle);
    setOutput("issue_body", result.issueBody);
    setOutput("skill", result.route === "skill" ? requestedSkill : "");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Dispatch resolution failed: ${msg}`);
    // Fall back to answer route on parse failure
    setOutput("route", "answer");
    setOutput("needs_approval", "false");
    setOutput("confidence", "low");
    setOutput("summary", "Could not parse dispatch response; falling back to answer.");
    setOutput("issue_title", "");
    setOutput("issue_body", "");
    setOutput("skill", "");
  }
}

let raw = "";
if (responseFile) {
  try {
    raw = readFileSync(responseFile, "utf8");
  } catch {
    console.error(`Could not read response file: ${responseFile}`);
    process.exitCode = 1;
  }
}

if (requestedRoute || raw) {
  const accessPolicy = loadAccessPolicy();
  if (!accessPolicy) {
    process.exitCode = 2;
  } else {
    emitDecision(accessPolicy);
  }
}
