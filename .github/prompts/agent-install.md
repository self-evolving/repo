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
- Do not post comments directly or close issues directly; return the reply body
  and let the workflow post it and close completed issue-backed requests.
- When `TARGET_KIND` is `issue`, `${TARGET_URL}` is the source installation
  request issue in `self-evolving/repo`.

## Required Flow

1. Resolve the target repository with the typed helper:
   `node .agent/dist/cli/resolve-install-target.js`.
   - If it reports `missing` or `ambiguous`, stop and return a concise
     clarification request.
   - Use the normalized `target_repo` from the helper for all GitHub operations.
2. Confirm `GH_TOKEN` is present. It must come from `AGENT_INSTALL_PAT`; do not
   read or pass any token through CLI flags.
3. Prepare the fork-backed target worktree with the helper:
   ```sh
   GH_TOKEN="$GH_TOKEN" node .agent/dist/cli/install-fork-pr.js prepare \
     --target-repo "<target_repo>"
   ```
   - Read the helper JSON or GitHub outputs.
   - If `status` is `blocked`, stop and return a concise blocked result with
     `blockedCode`, `message`, and the next step for the requester.
   - Work only in the returned `workdir`.
   - Carry forward `forkRepo`, `defaultBranch`, `branch`, and any reusable
     `prUrl` for publish.
   - If a reusable PR already exists, update that worktree and PR rather than
     creating a duplicate.
4. Resolve the Sepo source revision from the latest non-draft release of
   `self-evolving/repo`; include prereleases only when no stable release exists.
   If release lookup is unavailable, clearly report the fallback.
5. Perform the install in the prepared worktree: audit target-owned files, copy
   only approved Sepo-owned infrastructure, validate the diff, and commit the
   install changes.
6. Publish through the helper with flag-style arguments:
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
- installation request link when `TARGET_KIND` is `issue`: `${TARGET_URL}`
  (mention it as a reference, not with a closing keyword)
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

For a successful created or reused install PR, include exactly one hidden marker
in the final response so the workflow can close issue-backed install requests:

```md
<!-- sepo-install-status:published pr_url:<install-pr-url> -->
```

For blocked, missing-target, or ambiguous-target outcomes, do not include the
`published` marker; leave the request issue open so the requester can fix it.
