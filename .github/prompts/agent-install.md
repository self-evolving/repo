## Task Description

Install the Sepo agent infrastructure into the requested external GitHub
repository by opening or reusing a focused install PR.

## Route Contract

- This prompt is used only for the first-class `install` route.
- `REQUEST_TEXT` contains the full user request after permissive `/install`
  command detection.
- `GH_TOKEN` is the install-only `AGENT_INSTALL_PAT`. Do not use `AGENT_PAT`,
  the workflow token, or any other GitHub token fallback for target repository
  writes.
- Source repository memory is disabled for this route; do not write `agent/memory`
  or `agent/rubrics` during install runs.
- The fork/PR helper owns target GitHub mechanics. The install agent owns
  target-specific inspection, copy, validation, commit, and PR body judgment.
- Do not post comments directly; return the reply body and let the workflow post
  it.

## Required Flow

1. Resolve the target repository with
   `node .agent/dist/cli/resolve-install-target.js` and read its JSON from
   stdout.
   - If it reports `missing` or `ambiguous`, stop and return a concise
     clarification request using the helper message.
   - Use only the normalized `target_repo` returned by the helper; do not infer
     a target from prose after this step.
2. Confirm `GH_TOKEN` is present. It must come from `AGENT_INSTALL_PAT`; do not
   read or pass any token through CLI flags.
3. Prepare the fork-backed target worktree with the helper:
   ```sh
   GH_TOKEN="$GH_TOKEN" node .agent/dist/cli/install-fork-pr.js prepare \
     --target-repo "<target_repo>" \
     --branch "agent/install-agent-infra"
   ```
   - Read the helper JSON or GitHub outputs.
   - If `status` is `blocked`, stop and return a concise blocked result with
     `blockedCode`, `message`, and the next step for the requester.
   - Work only in the returned `workdir`.
   - Carry forward `forkRepo`, `defaultBranch`, `branch`, and any reusable
     `prUrl` for publish.
   - If a reusable PR already exists, update that worktree and PR rather than
     creating a duplicate.
   - Do not replace helper-owned fork branch or PR operations with raw
     `git push`, `gh pr create`, or equivalent commands.
4. Resolve the Sepo source release before copying install files.
   - Prefer the latest non-draft stable release from `self-evolving/repo`.
   - If no stable release exists, use the latest non-draft prerelease and state
     that fallback in the PR body.
   - Record the source ref, source commit SHA, and release URL or fallback
     reason.
5. Inspect the target worktree and copy only approved Sepo-owned install files.
   - Preserve target-owned application code and repository content.
   - For `.github/`, audit same-path conflicts before copying. Do not overwrite
     target-owned workflows, actions, prompts, or helper assets unless a
     maintainer explicitly requested that exact replacement.
   - Copy `.agent/` from the selected source, excluding generated or dependency
     directories such as `.agent/dist/`, `.agent/node_modules/`, and `.git`.
   - Merge `.agent/dist/` and `.agent/node_modules/` into the target
     `.gitignore` idempotently. Create `.gitignore` when missing; append only
     missing entries.
   - Add optional `.skills/<requested-skill>/SKILL.md` or root `AGENT.md` only
     when explicitly requested.
6. Validate and commit the install diff in the prepared worktree.
   - Review `git status --short` and `git diff --stat`.
   - Confirm the staged diff is limited to the approved install scope plus the
     idempotent `.gitignore` updates.
   - Stage the validated files and create a focused install commit.
   - If no staged changes exist, stop and report that no install diff was
     produced rather than publishing the previous `HEAD`.
7. Write a markdown PR body file in the prepared worktree.
   - Include source revision, files installed/skipped/preserved, validation, and
     required setup after merge.
   - Use the file path as `--pr-body-file` for the publish helper.
8. If a step cannot be completed, stop and return a blocked result that names
   the failed step and the needed next action. For target write failures, say to
   update `AGENT_INSTALL_PAT` or target repository access before rerunning
   `/install`.
9. Publish through the helper with flag-style arguments:
   ```sh
   GH_TOKEN="$GH_TOKEN" node .agent/dist/cli/install-fork-pr.js publish \
     --target-repo "<target_repo>" \
     --workdir "<workdir>" \
     --fork-repo "<forkRepo>" \
     --default-branch "<defaultBranch>" \
     --branch "<branch>" \
     --pr-title "Install Sepo agent infrastructure" \
     --pr-body-file "<body-file>"
   ```
   If publish returns `blocked`, report `blockedCode`, `message`, and the
   requester action needed to unblock it. Otherwise report the reused or created
   install PR URL.

## Scope

Install only:

- `.agent/`, excluding generated/dependency directories
- Sepo-owned `.github/` workflows, actions, prompts, and helper assets, merged
  without deleting target-only content
- optional `.skills/<requested-skill>/SKILL.md` or root `AGENT.md` only when
  explicitly requested

Never overwrite target application code, repository secrets, branch protection,
target-owned `.github` functionality, or the target root `README.md` unless the
request explicitly asks for that replacement.

## PR Body

The install PR body should include:

- target repository and branch
- source Sepo repo/ref/SHA/release URL or fallback reason
- files installed, skipped, preserved, or requiring owner review
- validation results and skipped checks
- a structured **Required setup after merge** section:
  1. install the Sepo GitHub App on the target repository, or choose another
     supported auth path from the setup guide
  2. add `OPENAI_API_KEY` and/or `CLAUDE_CODE_OAUTH_TOKEN`
  3. run **Actions > Agent / Onboarding / Check Setup**
  4. review the `Sepo setup check` issue and complete remaining setup
  5. initialize `agent/memory` if missing
  6. optionally initialize `agent/rubrics`

## Final Response

Return concise GitHub-flavored markdown with the target repo, PR URL or blocked
reason, source revision, validation summary, and remaining setup steps.
