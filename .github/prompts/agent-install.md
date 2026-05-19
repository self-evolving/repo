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
- Do not post comments directly; return the reply body and let the workflow post
  it.

## Required Flow

1. Resolve the target repository with the typed helper:
   `node .agent/dist/cli/resolve-install-target.js`.
   - If it reports `missing` or `ambiguous`, stop and return a concise
     clarification request.
   - Use the normalized `target_repo` from the helper for all GitHub operations.
2. Confirm the active `GH_TOKEN` identity and target write path before editing.
   If the token cannot push a branch or open a PR for the target repository,
   return a blocked result that names the permission gap and says to update
   `AGENT_INSTALL_PAT` or target repository access before rerunning `/install`.
3. Check for an existing open install PR before commit, push, or PR creation:
   `gh pr list --repo <target_repo> --head agent/install-agent-infra --state open --json number,url,state`.
   If one exists, report the PR URL and stop unless the requester explicitly
   asked to update or reuse it.
4. Resolve the Sepo source revision from the latest non-draft release of
   `self-evolving/repo`; include prereleases only when no stable release exists.
   If release lookup is unavailable, clearly report the fallback.
5. Prepare a target worktree from the target default branch, copy only approved
   Sepo-owned infrastructure, and preserve target-owned files.
6. Validate the diff and open a PR from `agent/install-agent-infra`.

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
