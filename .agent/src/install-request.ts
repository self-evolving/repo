import { execFileSync } from "node:child_process";

const VALID_REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export type InstallRequestCompletionStatus = "closed" | "skipped" | "failed";

export interface InstallRequestRunner {
  gh(args: string[]): string;
}

export interface CompleteInstallRequestOptions {
  sourceRepo: string;
  targetKind: string;
  targetNumber: number | string;
  installStatus: string;
  prUrl: string;
  runner?: InstallRequestRunner;
}

export interface CompleteInstallRequestResult {
  status: InstallRequestCompletionStatus;
  sourceRepo: string;
  issueNumber: string;
  prUrl: string;
  comment: string;
  reason: string;
  message: string;
}

export const defaultInstallRequestRunner: InstallRequestRunner = {
  gh(args) {
    return execFileSync("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).toString("utf8");
  },
};

function result(
  status: InstallRequestCompletionStatus,
  opts: CompleteInstallRequestOptions,
  fields: Partial<CompleteInstallRequestResult>,
): CompleteInstallRequestResult {
  return {
    status,
    sourceRepo: String(opts.sourceRepo || "").trim(),
    issueNumber: normalizeIssueNumber(opts.targetNumber),
    prUrl: normalizeInstallPrUrl(opts.prUrl),
    comment: "",
    reason: "",
    message: "",
    ...fields,
  };
}

function normalizeIssueNumber(value: number | string): string {
  const raw = String(value || "").trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? raw : "";
}

function normalizeInstallPrUrl(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 4 || parts[2] !== "pull" || !/^\d+$/.test(parts[3])) return "";
    return `https://github.com/${parts.join("/")}`;
  } catch {
    return "";
  }
}

function normalizeIssueState(raw: string): string {
  return String(raw || "").trim().toUpperCase();
}

export function completeInstallRequest(opts: CompleteInstallRequestOptions): CompleteInstallRequestResult {
  const targetKind = String(opts.targetKind || "").trim().toLowerCase();
  if (targetKind !== "issue") {
    return result("skipped", opts, {
      reason: "not_issue_backed",
      message: "Install request completion only closes issue-backed install requests.",
    });
  }

  const sourceRepo = String(opts.sourceRepo || "").trim();
  if (!VALID_REPO_SLUG.test(sourceRepo)) {
    return result("failed", opts, {
      reason: "invalid_source_repo",
      message: "Source repository must be in owner/repo form.",
    });
  }

  const issueNumber = normalizeIssueNumber(opts.targetNumber);
  if (!issueNumber) {
    return result("failed", opts, {
      reason: "invalid_issue_number",
      message: "Source issue number is missing or invalid.",
    });
  }

  if (String(opts.installStatus || "").trim().toLowerCase() !== "published") {
    return result("skipped", opts, {
      reason: "install_not_published",
      message: "Install request was not closed because publish did not complete.",
    });
  }

  const prUrl = normalizeInstallPrUrl(opts.prUrl);
  if (!prUrl) {
    return result("failed", opts, {
      reason: "invalid_pr_url",
      message: "Install PR URL is missing or invalid.",
    });
  }

  const runner = opts.runner || defaultInstallRequestRunner;
  let state = "";
  try {
    state = normalizeIssueState(runner.gh([
      "issue",
      "view",
      issueNumber,
      "--repo",
      sourceRepo,
      "--json",
      "state",
      "--jq",
      ".state",
    ]));
  } catch {
    return result("failed", opts, {
      reason: "issue_state_unavailable",
      prUrl,
      message: `Could not read source install request issue ${sourceRepo}#${issueNumber}.`,
    });
  }

  if (state === "CLOSED") {
    return result("skipped", opts, {
      reason: "already_closed",
      prUrl,
      message: `Source install request issue ${sourceRepo}#${issueNumber} is already closed.`,
    });
  }

  const comment = `Installation PR is ready: ${prUrl}`;
  try {
    runner.gh([
      "issue",
      "close",
      issueNumber,
      "--repo",
      sourceRepo,
      "--comment",
      comment,
    ]);
  } catch {
    return result("failed", opts, {
      reason: "close_failed",
      prUrl,
      comment,
      message: `Could not close source install request issue ${sourceRepo}#${issueNumber}.`,
    });
  }

  return result("closed", opts, {
    reason: "",
    prUrl,
    comment,
    message: `Closed source install request issue ${sourceRepo}#${issueNumber}.`,
  });
}
