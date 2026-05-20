// CLI: apply dispatch policy to agent triage output.
// Usage: node .agent/dist/cli/resolve-dispatch.js
// Env: RESPONSE_FILE, TARGET_KIND, TARGET_NUMBER, AUTHOR_ASSOCIATION,
//      REQUESTED_ROUTE, REQUEST_TEXT, REQUESTED_SKILL, ACCESS_POLICY,
//      REPOSITORY_PRIVATE, GITHUB_REPOSITORY, GH_TOKEN
// Outputs: route, needs_approval, confidence, summary, issue_title, issue_body,
//          skill, base_pr

import { readFileSync } from "node:fs";
import { type AccessPolicy, parseAccessPolicy } from "../access-policy.js";
import { fetchPrMeta } from "../github.js";
import { setOutput } from "../output.js";
import {
  type ImplementIssueMetadata,
  normalizeDispatch,
  applyDispatchPolicy,
  buildRequestedRouteDecision,
  normalizeImplementIssueMetadata,
} from "../triage.js";

const responseFile = process.env.RESPONSE_FILE || "";
const targetKind = process.env.TARGET_KIND || "";
const targetNumber = String(process.env.TARGET_NUMBER || "").trim();
const authorAssociation = process.env.AUTHOR_ASSOCIATION || "";
const requestedRoute = String(process.env.REQUESTED_ROUTE || "").trim().toLowerCase();
const requestedSkill = String(process.env.REQUESTED_SKILL || "").trim();
const requestText = process.env.REQUEST_TEXT || "";
const isPublicRepo = String(process.env.REPOSITORY_PRIVATE || "").trim().toLowerCase() === "false";
const repo = process.env.GITHUB_REPOSITORY || "";

function loadAccessPolicy(): AccessPolicy | null {
  try {
    return parseAccessPolicy(process.env.ACCESS_POLICY || "");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid AGENT_ACCESS_POLICY: ${msg}`);
    return null;
  }
}

function appendClosedInferredBaseNote(body: string, basePr: string, state: string): string {
  const note = [
    "## Base branch note",
    `PR #${basePr} is ${state.toLowerCase()}, so implementation will start from the repository default branch while keeping that PR as context.`,
  ].join("\n");
  const trimmed = String(body || "").trim();
  if (!trimmed) return note;
  if (trimmed.includes(note)) return trimmed;
  return `${trimmed}\n\n${note}`;
}

function normalizeInferredImplementBase(metadata: ImplementIssueMetadata | null): ImplementIssueMetadata | null {
  if (
    !metadata?.basePr ||
    targetKind !== "pull_request" ||
    metadata.basePr !== targetNumber ||
    !repo
  ) {
    return metadata;
  }

  try {
    const meta = fetchPrMeta(Number.parseInt(metadata.basePr, 10), repo);
    const state = String(meta.state || "").trim().toUpperCase();
    if (!state || state === "OPEN") {
      return metadata;
    }

    console.warn(
      `Dropping inferred base_pr #${metadata.basePr} because source PR is ${state.toLowerCase()}; using the default branch instead.`,
    );
    return {
      ...metadata,
      basePr: "",
      issueBody: appendClosedInferredBaseNote(metadata.issueBody, metadata.basePr, state),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Could not verify inferred base_pr #${metadata.basePr}; keeping it for implementation base resolution: ${msg}`);
    return metadata;
  }
}

function emitDecision(accessPolicy: AccessPolicy): void {
  try {
    const isExplicit = Boolean(requestedRoute);
    const implementMetadata = isExplicit && requestedRoute === "implement" && raw.trim()
      ? (() => {
          try {
            return normalizeInferredImplementBase(normalizeImplementIssueMetadata(raw));
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Implement issue metadata was invalid; using fallback metadata: ${msg}`);
            return null;
          }
        })()
      : null;
    const decision = isExplicit
      ? buildRequestedRouteDecision(requestedRoute, requestText, implementMetadata)
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
    setOutput("base_pr", result.route === "implement" ? result.basePr || "" : "");
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
    setOutput("base_pr", "");
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
