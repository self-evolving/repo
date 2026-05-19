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
  env?: Record<string, string>;
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

const TARGET_WORKTREE_SLOT: InstallLifecycleTemplateSlot = {
  name: "target_worktree",
  sourceStep: "prepare-install-worktree",
  description: "Use the workdir returned by the helper prepare step.",
};

const TARGET_DEFAULT_BRANCH_SLOT: InstallLifecycleTemplateSlot = {
  name: "target_default_branch",
  sourceStep: "prepare-install-worktree",
  description: "Use the defaultBranch returned by the helper prepare step.",
};

const SOURCE_CHECKOUT_SLOT: InstallLifecycleTemplateSlot = {
  name: "source_checkout",
  sourceStep: "checkout-source-release",
  description: "Use the clean source checkout created from the selected Sepo release.",
};

const INSTALL_TOKEN_ENV = {
  GH_TOKEN: "AGENT_INSTALL_PAT",
};

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
        command: `node .agent/dist/cli/install-fork-pr.js prepare --target-repo ${targetRepo} --branch ${installBranch}`,
        env: INSTALL_TOKEN_ENV,
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
        id: "checkout-source-release",
        title: "Check out the selected Sepo source release",
        commandTemplate: `git clone --depth 1 --branch {{source_ref}} https://github.com/${sourceRepo}.git {{source_checkout}}`,
        templateSlots: [
          {
            name: "source_ref",
            sourceStep: "resolve-source-release",
            description: "Use the selected Sepo release tag or fallback ref.",
          },
          {
            name: "source_checkout",
            sourceStep: "resolve-source-release",
            description: "Choose an empty temporary directory for the selected Sepo source checkout.",
          },
        ],
        description:
          "Materialize the selected Sepo source revision before copying install files.",
      },
      {
        id: "copy-install-scope",
        title: "Copy the approved install scope",
        commandTemplate: "rsync -a --exclude node_modules --exclude dist --exclude .git {{source_checkout}}/.agent/ {{target_worktree}}/.agent/ && rsync -a --exclude node_modules --exclude dist --exclude .git {{source_checkout}}/.github/ {{target_worktree}}/.github/",
        templateSlots: [SOURCE_CHECKOUT_SLOT, TARGET_WORKTREE_SLOT],
        description:
          "Fill the template slots before running the executable copy command; preserve target-owned files by copying only the approved Sepo infrastructure roots.",
      },
      {
        id: "validate-install-diff",
        title: "Validate the install diff",
        commandTemplate: "git -C {{target_worktree}} status --short && git -C {{target_worktree}} diff --stat",
        templateSlots: [TARGET_WORKTREE_SLOT],
        description:
          "Confirm the diff is limited to the approved install scope and run lightweight checks that are available in the target worktree.",
      },
      {
        id: "stage-install-changes",
        title: "Stage the install changes",
        commandTemplate: "git -C {{target_worktree}} add .agent .github",
        templateSlots: [TARGET_WORKTREE_SLOT],
        description:
          "Stage the required install scope; stage optional approved paths separately only when the requester explicitly included them.",
      },
      {
        id: "commit-install-changes",
        title: "Commit the install changes",
        commandTemplate: "git -C {{target_worktree}} commit -m 'chore: install Sepo agent infrastructure'",
        templateSlots: [TARGET_WORKTREE_SLOT],
        description:
          "Create the install commit after validation; if there are no staged changes, stop and report that no install diff was produced.",
      },
      {
        id: "publish-install-pr",
        title: "Publish the install PR",
        commandTemplate: `node .agent/dist/cli/install-fork-pr.js publish --target-repo ${targetRepo} --workdir {{target_worktree}} --fork-repo {{fork_repo}} --default-branch {{target_default_branch}} --branch ${installBranch} --pr-title 'Install Sepo agent infrastructure' --pr-body-file {{install_pr_body_file}}`,
        env: INSTALL_TOKEN_ENV,
        templateSlots: [
          TARGET_DEFAULT_BRANCH_SLOT,
          TARGET_WORKTREE_SLOT,
          {
            name: "fork_repo",
            sourceStep: "prepare-install-worktree",
            description: "Use the forkRepo returned by the helper prepare step.",
          },
          {
            name: "install_pr_body_file",
            sourceStep: "commit-install-changes",
            description: "Use the generated install PR body file after validation.",
          },
        ],
        description:
          "Fill all template slots after committing the install diff, then use the helper to push the fork branch and reuse or open the install PR with source revision, installed files, validation, and required setup after merge.",
      },
    ],
  };
}
