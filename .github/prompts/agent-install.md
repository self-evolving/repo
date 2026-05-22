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
3. Use these install defaults:
   - install branch: `agent/install-agent-infra`
   - source repository: `self-evolving/repo`
   - PR title: `Install Sepo agent infrastructure`
4. Resolve the Sepo source revision before copying files.
   - Prefer the latest non-draft stable release from the source repository.
   - If no stable release exists, use the latest non-draft prerelease.
   - Record the selected ref, commit SHA, release URL, and fallback reason if
     no stable release was available.
5. Prepare the fork-backed target worktree with the helper:
   ```sh
   GH_TOKEN="$GH_TOKEN" node .agent/dist/cli/install-fork-pr.js prepare \
     --target-repo "<target_repo>" \
     --branch "<install_branch>"
   ```
   - Read the helper JSON or GitHub outputs.
   - If `status` is `blocked`, stop and return a concise blocked result with
     `blockedCode`, `message`, and the next step for the requester.
   - Work only in the returned `workdir`.
   - Carry forward `forkRepo`, `defaultBranch`, `branch`, and any reusable
     `prUrl` for publish.
   - If a reusable PR already exists, update that worktree and PR rather than
     creating a duplicate.
6. Do the target-specific install work in the returned `workdir`.
   - Check out the selected Sepo source revision into a temporary source
     checkout.
   - Copy `.agent/` from the source checkout into the target workdir, excluding
     `.git`, `dist`, and `node_modules`.
   - Before copying `.github/`, audit same-path `.github` files in the source
     and target. Stop for owner review if a source file would overwrite an
     existing target `.github` file, unless the requester explicitly asked for
     that exact replacement. Otherwise copy Sepo-owned `.github/` paths without
     deleting target-only files.
   - Merge `.agent/dist/` and `.agent/node_modules/` into the target
     `.gitignore` when missing. Preserve existing ignore entries and make the
     update idempotent.
   - Add optional `.skills/<requested-skill>/SKILL.md` or root `AGENT.md` only
     when explicitly requested.
7. Validate, stage, and commit the install diff before publishing.
   - Review `git status --short` and `git diff --stat` in the target workdir.
   - Stage `.agent`, `.github`, `.gitignore`, and any explicitly requested
     optional files.
   - If no staged changes exist, stop and report that no install diff was
     produced rather than publishing the previous `HEAD`.
   - Commit with `chore: install Sepo agent infrastructure`.
8. Write an install PR body file in the prepared workdir after committing the
   install diff. Include the PR body details below and use that file path for
   publish.
9. If a step cannot be completed, stop and return a blocked result that names
   the failed step and the needed next action. For target write failures, say to
   update `AGENT_INSTALL_PAT` or target repository access before rerunning
   `/install`.
10. Publish through the helper with flag-style arguments:
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
   For issue-backed requests, the helper derives the source request URL from the
   runtime envelope and adds it to the PR body before creating or updating the
   install PR.
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

1. `## Summary`
2. `## Required setup after merge`
3. `## Source revision`
4. installed files, preserved/skipped files, validation details, and skipped
   checks

The structured **Required setup after merge** section must be near the top and
use target-specific links where possible:

1. install the Sepo GitHub App on the target repository, or choose another
   supported auth path from the setup guide
2. add `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and/or
   `ANTHROPIC_API_KEY` in the target repository's Actions secrets
3. run the target repository's `Agent / Onboarding / Check Setup` workflow
4. review the target repository's `Sepo setup check` issue and complete
   remaining setup
5. run `Agent / Memory / Initialization` if `agent/memory` is missing
6. optionally run `Agent / Rubrics / Initialization` if `agent/rubrics` is
   wanted

The publish helper normalizes this setup section before creating or updating the
PR and then preserves or appends the source install request link for `/install`
issue requests.

## Final Response

Return concise GitHub-flavored markdown with the target repo, PR URL or blocked
reason, source revision, validation summary, and remaining setup steps.
