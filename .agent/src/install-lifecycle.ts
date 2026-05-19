import {
  type InstallTargetResolution,
  resolveInstallTargetFromText,
} from "./install-target.js";

export const DEFAULT_INSTALL_BRANCH = "agent/install-agent-infra";
export const DEFAULT_SOURCE_REPO = "self-evolving/repo";

export type InstallLifecycleStatus = InstallTargetResolution["status"];

export interface InstallLifecycleStep {
  id: string;
  title: string;
  command?: string;
  commandTemplate?: string;
  templateSlots?: InstallLifecycleTemplateSlot[];
  description: string;
}

export interface InstallLifecycleTemplateSlot {
  name: string;
  sourceStep: string;
  description: string;
}

export interface InstallLifecyclePlan {
  status: InstallLifecycleStatus;
  targetRepo: string;
  installBranch: string;
  sourceRepo: string;
  candidates: string[];
  message: string;
  steps: InstallLifecycleStep[];
}

export interface InstallLifecyclePlanInput {
  requestText: string;
  installBranch?: string;
  sourceRepo?: string;
}

function cleanInput(value: string | undefined, fallback: string): string {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

function blockedPlan(
  target: InstallTargetResolution,
  installBranch: string,
  sourceRepo: string,
): InstallLifecyclePlan {
  return {
    status: target.status,
    targetRepo: "",
    installBranch,
    sourceRepo,
    candidates: target.candidates,
    message: target.message,
    steps: [],
  };
}

export function buildInstallLifecyclePlan(input: InstallLifecyclePlanInput): InstallLifecyclePlan {
  const installBranch = cleanInput(input.installBranch, DEFAULT_INSTALL_BRANCH);
  const sourceRepo = cleanInput(input.sourceRepo, DEFAULT_SOURCE_REPO);
  const target = resolveInstallTargetFromText(input.requestText);
  if (target.status !== "clear") {
    return blockedPlan(target, installBranch, sourceRepo);
  }

  const targetRepo = target.targetRepo;
  return {
    status: "clear",
    targetRepo,
    installBranch,
    sourceRepo,
    candidates: target.candidates,
    message: target.message,
    steps: [
      {
        id: "check-target-write",
        title: "Check target repository access",
        command: `gh api repos/${targetRepo} --jq '{default_branch: .default_branch, permissions: .permissions}'`,
        description:
          "Confirm the install token can read the target repository and has push/write permission before preparing changes.",
      },
      {
        id: "check-existing-install-pr",
        title: "Check for an existing install PR",
        command: `gh pr list --repo ${targetRepo} --head ${installBranch} --state open --json number,url,state,headRefName`,
        description:
          "Reuse or report the open install PR before committing, pushing, or creating a new PR.",
      },
      {
        id: "resolve-source-release",
        title: "Resolve the Sepo source release",
        command: `gh release list --repo ${sourceRepo} --json tagName,isDraft,isPrerelease,url,publishedAt --limit 30`,
        description:
          "Select the latest non-draft stable release, falling back to the latest non-draft prerelease only when no stable release exists.",
      },
      {
        id: "prepare-target-branch",
        title: "Prepare the target install branch",
        commandTemplate: `git checkout -B ${installBranch} {{target_default_branch}}`,
        templateSlots: [
          {
            name: "target_default_branch",
            sourceStep: "check-target-write",
            description: "Use the target repository default_branch returned by the access check.",
          },
        ],
        description:
          "Fill the template slot before running; create or update the install branch from the target repository default branch in a clean target worktree.",
      },
      {
        id: "copy-install-scope",
        title: "Copy the approved install scope",
        commandTemplate: "copy .agent/ and Sepo-owned .github assets from {{source_checkout}} into {{target_worktree}}",
        templateSlots: [
          {
            name: "source_checkout",
            sourceStep: "resolve-source-release",
            description: "Use the checkout for the selected Sepo source revision.",
          },
          {
            name: "target_worktree",
            sourceStep: "prepare-target-branch",
            description: "Use the clean target worktree on the install branch.",
          },
        ],
        description:
          "Fill the template slots before copying only Sepo-owned infrastructure, preserving target-owned application code and unrelated GitHub assets.",
      },
      {
        id: "validate-install-diff",
        title: "Validate the install diff",
        command: "git status --short && git diff --stat",
        description:
          "Confirm the diff is limited to the approved install scope and run lightweight checks that are available in the target worktree.",
      },
      {
        id: "open-install-pr",
        title: "Open the install PR",
        commandTemplate: `gh pr create --repo ${targetRepo} --head ${installBranch} --base {{target_default_branch}} --title 'Install Sepo agent infrastructure' --body-file {{install_pr_body_file}}`,
        templateSlots: [
          {
            name: "target_default_branch",
            sourceStep: "check-target-write",
            description: "Use the target repository default_branch returned by the access check.",
          },
          {
            name: "install_pr_body_file",
            sourceStep: "validate-install-diff",
            description: "Use the generated install PR body file after validation.",
          },
        ],
        description:
          "Fill all template slots before opening the PR with source revision, installed files, validation, and required setup after merge.",
      },
    ],
  };
}
