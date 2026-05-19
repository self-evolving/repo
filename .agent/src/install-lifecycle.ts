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
        id: "prepare-install-worktree",
        title: "Prepare the fork-backed install worktree",
        command: `GH_TOKEN="$GH_TOKEN" node .agent/dist/cli/install-fork-pr.js prepare --target-repo ${targetRepo} --branch ${installBranch}`,
        description:
          "Use the install fork/PR helper to validate the public target, create or reuse the token-owner fork, detect reusable or duplicate install PRs, and prepare the fork branch from the current target default branch.",
      },
      {
        id: "resolve-source-release",
        title: "Resolve the Sepo source release",
        command: `gh release list --repo ${sourceRepo} --json tagName,isDraft,isPrerelease,url,publishedAt --limit 30`,
        description:
          "Select the latest non-draft stable release, falling back to the latest non-draft prerelease only when no stable release exists.",
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
            sourceStep: "prepare-install-worktree",
            description: "Use the helper-returned workdir on the install branch.",
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
        id: "publish-install-pr",
        title: "Publish the install PR",
        commandTemplate: `GH_TOKEN="$GH_TOKEN" node .agent/dist/cli/install-fork-pr.js publish --target-repo ${targetRepo} --workdir {{target_worktree}} --fork-repo {{fork_repo}} --default-branch {{target_default_branch}} --branch ${installBranch} --pr-title 'Install Sepo agent infrastructure' --pr-body-file {{install_pr_body_file}}`,
        templateSlots: [
          {
            name: "target_default_branch",
            sourceStep: "prepare-install-worktree",
            description: "Use the defaultBranch returned by the helper prepare step.",
          },
          {
            name: "target_worktree",
            sourceStep: "prepare-install-worktree",
            description: "Use the workdir returned by the helper prepare step.",
          },
          {
            name: "fork_repo",
            sourceStep: "prepare-install-worktree",
            description: "Use the forkRepo returned by the helper prepare step.",
          },
          {
            name: "install_pr_body_file",
            sourceStep: "validate-install-diff",
            description: "Use the generated install PR body file after validation.",
          },
        ],
        description:
          "Fill all template slots before using the helper to push the fork branch and reuse or open the install PR with source revision, installed files, validation, and required setup after merge.",
      },
    ],
  };
}
