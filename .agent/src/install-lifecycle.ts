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
  sourceStep: "setup-target-worktree",
  description: "Use the clean target repository worktree created by the setup step.",
};

const TARGET_DEFAULT_BRANCH_SLOT: InstallLifecycleTemplateSlot = {
  name: "target_default_branch",
  sourceStep: "check-target-write",
  description: "Use the target repository default_branch returned by the access check.",
};

const SOURCE_CHECKOUT_SLOT: InstallLifecycleTemplateSlot = {
  name: "source_checkout",
  sourceStep: "prepare-source-checkout-dir",
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
        id: "check-target-write",
        title: "Check target repository access",
        command: `gh api repos/${targetRepo} --jq 'if (.permissions.push == true) then {default_branch: .default_branch, permissions: .permissions} else error("AGENT_INSTALL_PAT lacks push permission for ${targetRepo}") end'`,
        env: INSTALL_TOKEN_ENV,
        description:
          "Fail before preparing changes unless AGENT_INSTALL_PAT can read the target repository and has push/write permission.",
      },
      {
        id: "check-existing-install-pr",
        title: "Check for an existing install PR",
        command: `gh pr list --repo ${targetRepo} --head ${installBranch} --state open --json number,url,state,headRefName`,
        env: INSTALL_TOKEN_ENV,
        description:
          "Reuse or report the open install PR before committing, pushing, or creating a new PR.",
      },
      {
        id: "configure-target-git-auth",
        title: "Configure target git authentication",
        command: "gh auth setup-git --hostname github.com",
        env: INSTALL_TOKEN_ENV,
        description:
          "Configure git credential lookup from GH_TOKEN, which is AGENT_INSTALL_PAT for install runs; do not use the normal repository token.",
      },
      {
        id: "resolve-source-release",
        title: "Resolve the Sepo source release",
        command: `gh release list --repo ${sourceRepo} --json tagName,isDraft,isPrerelease,url,publishedAt --limit 30`,
        description:
          "Select the latest non-draft stable release, falling back to the latest non-draft prerelease only when no stable release exists.",
      },
      {
        id: "prepare-source-checkout-dir",
        title: "Prepare the source checkout directory",
        command: "mktemp -d",
        description:
          "Create an empty temporary directory and record stdout as source_checkout for the selected Sepo source checkout.",
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
            sourceStep: "prepare-source-checkout-dir",
            description: "Use the empty temporary directory created for the selected Sepo source checkout.",
          },
        ],
        description:
          "Materialize the selected Sepo source revision before copying install files.",
      },
      {
        id: "setup-target-worktree",
        title: "Set up the target worktree",
        commandTemplate: `gh repo clone ${targetRepo} {{target_worktree}}`,
        env: INSTALL_TOKEN_ENV,
        templateSlots: [
          {
            name: "target_worktree",
            sourceStep: "check-target-write",
            description: "Choose an empty temporary directory for the target repository checkout.",
          },
        ],
        description:
          "Fill the target_worktree slot before cloning; use this clean target checkout for all later git operations.",
      },
      {
        id: "prepare-target-branch",
        title: "Prepare the target install branch",
        commandTemplate: `git -C {{target_worktree}} checkout -B ${installBranch} {{target_default_branch}}`,
        templateSlots: [TARGET_WORKTREE_SLOT, TARGET_DEFAULT_BRANCH_SLOT],
        description:
          "Fill the template slot before running; create or update the install branch from the target repository default branch in a clean target worktree.",
      },
      {
        id: "audit-github-copy-conflicts",
        title: "Audit target-owned GitHub asset conflicts",
        commandTemplate: "bash -lc 'conflicts=$(comm -12 <(cd \"$1\" && { [ ! -d .github ] || find .github -type f; } | sort) <(cd \"$2\" && { [ ! -d .github ] || find .github -type f; } | sort)); if [ -n \"$conflicts\" ]; then printf \"Blocked: target .github files already exist and need owner review before overwrite:\\n%s\\n\" \"$conflicts\" >&2; exit 1; fi' bash {{source_checkout}} {{target_worktree}}",
        templateSlots: [SOURCE_CHECKOUT_SLOT, TARGET_WORKTREE_SLOT],
        description:
          "Block before copying when source and target have same-path .github files so target-owned workflows, actions, and prompts are reviewed instead of overwritten.",
      },
      {
        id: "copy-install-scope",
        title: "Copy the approved install scope",
        commandTemplate: "rsync -a --exclude node_modules --exclude dist --exclude .git {{source_checkout}}/.agent/ {{target_worktree}}/.agent/ && rsync -a --ignore-existing --exclude node_modules --exclude dist --exclude .git {{source_checkout}}/.github/ {{target_worktree}}/.github/",
        templateSlots: [SOURCE_CHECKOUT_SLOT, TARGET_WORKTREE_SLOT],
        description:
          "Fill the template slots before running the executable copy command; preserve target-owned .github files by blocking same-path conflicts before copy and never overwriting existing .github paths.",
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
        id: "push-install-branch",
        title: "Push the install branch",
        commandTemplate: `git -C {{target_worktree}} push --set-upstream origin ${installBranch}`,
        env: INSTALL_TOKEN_ENV,
        templateSlots: [TARGET_WORKTREE_SLOT],
        description:
          "Push the committed install branch to the target repository with AGENT_INSTALL_PAT before opening the PR.",
      },
      {
        id: "open-install-pr",
        title: "Open the install PR",
        commandTemplate: `gh pr create --repo ${targetRepo} --head ${installBranch} --base {{target_default_branch}} --title 'Install Sepo agent infrastructure' --body-file {{install_pr_body_file}}`,
        env: INSTALL_TOKEN_ENV,
        templateSlots: [
          TARGET_DEFAULT_BRANCH_SLOT,
          {
            name: "install_pr_body_file",
            sourceStep: "commit-install-changes",
            description: "Use the generated install PR body file after validation.",
          },
        ],
        description:
          "Fill all template slots before opening the PR with source revision, installed files, validation, and required setup after merge.",
      },
    ],
  };
}
