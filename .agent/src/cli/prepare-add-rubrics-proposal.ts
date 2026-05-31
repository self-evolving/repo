// CLI: derive stable add-rubrics proposal branch metadata.
// Env: TARGET_KIND, TARGET_NUMBER, REQUEST_TEXT, REQUESTED_BY, GH_TOKEN,
//      GITHUB_REPOSITORY
// Outputs: branch, branch_lease_oid

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildAuthUrl } from "../git.js";
import { setOutput } from "../output.js";

function hashRequest(parts: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

function branchComponent(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function findRemoteBranchOid(opts: { branch: string; repo: string; token: string }): string {
  if (!opts.branch || !opts.repo || !opts.token) return "";
  try {
    const output = execFileSync("git", [
      "ls-remote",
      "--heads",
      buildAuthUrl(opts.token, opts.repo),
      opts.branch,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    }).trim();
    const [oid] = output.split(/\s+/);
    return /^[0-9a-f]{40}$/i.test(oid) ? oid : "";
  } catch {
    return "";
  }
}

const targetKind = process.env.TARGET_KIND || "target";
const targetNumber = process.env.TARGET_NUMBER || "0";
const requestText = process.env.REQUEST_TEXT || "";
const requestedBy = process.env.REQUESTED_BY || "";
const repo = process.env.GITHUB_REPOSITORY || "";
const token = process.env.GH_TOKEN || "";

const requestHash = hashRequest({
  targetKind,
  targetNumber,
  requestText,
  requestedBy,
});
const branch = [
  "agent",
  `${branchComponent("add-rubrics", "add-rubrics")}-${branchComponent(targetKind, "target")}-${branchComponent(targetNumber, "0")}`,
  `request-${requestHash}`,
].join("/");
const leaseOid = findRemoteBranchOid({ branch, repo, token });

setOutput("branch", branch);
setOutput("branch_lease_oid", leaseOid);
console.log(`Proposal branch: ${branch}`);
if (leaseOid) console.log("Existing proposal branch found; push will use force-with-lease.");
