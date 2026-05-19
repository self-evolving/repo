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

1. Build the typed lifecycle plan with
   `node .agent/dist/cli/plan-install-lifecycle.js` and read its JSON from
   stdout.
   - If it reports `missing` or `ambiguous`, stop and return a concise
     clarification request using the helper message.
   - Use the normalized `target_repo`, `install_branch`, `source_repo`, and
     ordered `steps` from the plan for all install operations.
2. Execute the plan steps in order. Treat the step IDs, commands, command
   templates, template slots, and descriptions as the deterministic install
   contract for target write-path probing, existing PR reuse, source release
   selection, branch preparation, diff validation, and PR creation. Never run a
   `commandTemplate` until every `templateSlots` entry has been filled from its
   named `sourceStep`.
3. If a step cannot be completed, stop and return a blocked result that names
   the failed step and the needed next action. For target write failures, say to
   update `AGENT_INSTALL_PAT` or target repository access before rerunning
   `/install`.

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
