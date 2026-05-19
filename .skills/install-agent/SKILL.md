---
name: install-agent
description: Install the Sepo agent infrastructure into another GitHub repository through a focused pull request. Use when asked to add, bootstrap, or onboard this agent backend while auditing conflicts, preserving repo-owned files, validating the diff, and guiding post-merge memory/rubrics setup.
---

# Install Agent

Use this skill to add the Sepo agent backend to an existing repository by
opening a normal PR. Keep the target repository's application code and unrelated
GitHub assets intact.

## Inputs

Confirm these before editing:

- target repository slug and default branch
- source agent repo/ref, defaulting to the latest non-draft release from
  `self-evolving/repo`; include prereleases when no stable release exists
- install branch name, defaulting to `agent/install-agent-infra`
- active install GitHub identity from `GH_TOKEN`; for `@sepo-agent /install`
  this is the `AGENT_INSTALL_PAT` machine-user token, and it must be able to
  open the install PR
- model provider secret plan: `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or both
- whether to copy any `.skills/` directories; default is no
- whether to copy root `AGENT.md`; default is no

When invoked through `@sepo-agent /install`, the router authorizes the
install route and passes the full user request through as `REQUEST_TEXT`.
Resolve the target from that text, accepting an `owner/repo` slug, a GitHub
repository URL, or a clear natural-language repository reference. Stop with a
clarification if the request has no target, multiple plausible targets, or a
target that cannot be normalized to exactly one GitHub repository slug.

Current auth contract: `/install` is authorized as the `install` route, then the
router refuses to run this skill unless the source repository has the
`AGENT_INSTALL_PAT` secret configured. For `/install`, the task receives that
secret as `GH_TOKEN` instead of the normal GitHub App/OIDC/`AGENT_PAT` resolver
token. Generic `/skill install-agent` runs keep the normal resolved token, but
the supported external install path is `/install` with a clear target request.

Use only the active `GH_TOKEN` for GitHub operations. Do not read another token
secret, add an install policy, or assume configuring a new App/PAT during the
run changes the active token. If `GH_TOKEN` cannot push or open the install PR
for the target repository, stop with a blocked result that names the permission
gap and tells the requester to update `AGENT_INSTALL_PAT` or the target
repository access before rerunning `/install`.

Stop if the target repo, branch, source revision, or active write identity is
ambiguous.

## Agent-Owned Scope

Install only this agent infrastructure:

- `.agent/`, excluding generated/dependency directories
- the source repo's `.github/` agent assets as a set, merged into the target
  `.github/` without deleting target-only content:
  - workflows, actions, prompts, and scripts/functions under source `.github/`
  - source prompt `.md` files copied by file name while preserving target-only
    prompts
  - existing target workflows, actions, prompts, scripts/functions, or other
    `.github` files preserved unless explicitly approved for replacement
- optional `.skills/<requested-skill>/SKILL.md`, only with explicit approval
- optional `AGENT.md`, only with explicit approval

Do not install or overwrite target application source, repository secrets, branch
protection, target-owned `.github` functionality, or the target root `README.md`
unless explicitly requested.

## Guardrails

- Never push directly to the target default branch or merge the PR unless asked.
- Never overwrite divergent files or remove target-only files without showing an
  audit and getting confirmation.
- Treat target `.github/` content and `.skills/` as shared/user-owned
  namespaces.
- Do not use `rsync --delete` on `.github/`, `.github/prompts/`, or `.skills/`.
  Delete target `.github` or skill files only after explicit file-by-file
  approval.
- Do not copy generated or local-only files: `node_modules/`, `dist/`,
  `.agent/node_modules/`, `.agent/dist/`, `.git/`, `_worktrees/`, or
  `.claude/worktrees/`.
- Merge agent-generated-output ignore rules into the target's existing
  `.gitignore` instead of replacing it: at least `.agent/dist/` and
  `.agent/node_modules/`.
- Do not ask users to paste secrets into issues, PRs, comments, or committed
  files. Direct them to GitHub settings or `gh secret set` in a trusted shell.

## Workflow

1. Read source deployment docs first:
   - `.agent/docs/deployment/install-existing-repository.md`
   - `.agent/docs/deployment/setup-guide.md`

2. Resolve the source Sepo revision before copying.
   - Prefer the latest non-draft GitHub Release from `self-evolving/repo`.
   - If no stable release exists yet, use the latest non-draft prerelease.
   - Use the current checkout only when the user explicitly asks for it or
     release lookup is unavailable and you clearly report the fallback.
   - Record the source repo, ref/tag, SHA, and release URL or fallback reason in
     the PR body.

3. Prepare the target checkout.
   - Clone/open the target repo.
   - Verify the already-resolved `GH_TOKEN` can write to the target repository
     before editing: check the authenticated identity and target permission with
     `gh auth status` and `gh api repos/<owner>/<repo> --jq '.viewerPermission // .permissions.push // empty'`.
   - If the active token cannot push to the target repository, report the
     install as blocked and do not proceed to commit, push, fork, or open a PR.
   - Create the install branch from the target default branch.
   - Check `git status --short`; stop if unrelated local changes would make the
     install ambiguous.

4. Audit before copying.
   - Inspect every path in **Agent-Owned Scope**.
   - Check related branches/refs:
     `git ls-remote --heads origin agent/memory agent/rubrics 'agent/*'`.
   - Check for an existing open install PR before continuing toward
     commit/push/PR creation:
     `gh pr list --repo <owner>/<repo> --head agent/install-agent-infra --state open --json number,url,state`.
     If one exists, report its URL and stop unless the user explicitly asks to
     update or reuse it.
   - Check existing secrets/variables/workflows where permissions allow:
     `gh secret list`, `gh variable list`, and `gh workflow list`.
   - Look for legacy or overlapping scaffolds such as `.flows/`, `.claude/`, old
     `run-claude-task` / `run-codex-task` actions, or stale `agent-*` workflows.
   - Classify overlaps as absent, identical, agent-owned divergent,
     repo-owned/custom, or legacy removal candidate.
   - Present the audit in a small table and ask before replacing divergent files
     or removing anything.

5. Copy the install files conservatively.
   - Sync `.agent/` with generated/dependency exclusions.
   - Preserve target-owned root files, but add the agent ignore entries
     `.agent/dist/` and `.agent/node_modules/` to the target `.gitignore` if
     missing so GitHub-hosted runner builds do not leak generated files into PRs.
   - Copy all source `.github/` files/directories into the target `.github/` by
     default, but merge rather than wholesale replace.
   - Preserve target-only `.github` files and replace existing `.github` files
     only when they are identical, clearly agent-owned, or explicitly approved.
   - Copy source prompt `.md` files without deleting target-only prompts.
   - Copy requested `.skills/` directories and `AGENT.md` only when approved.

6. Configure target repository guidance.
   - Do not commit secret values.
   - In the PR body, include a structured **Required setup after merge**
     section with numbered next steps:
     1. install the Sepo GitHub App on the target repository, or choose another
        supported auth path from the setup guide
     2. add at least one model-provider repository secret:
        `OPENAI_API_KEY` and/or `CLAUDE_CODE_OAUTH_TOKEN`
     3. run **Actions > Agent / Onboarding / Check Setup**
     4. review the `Sepo setup check` issue and complete any remaining setup it
        reports
     5. run **Actions > Agent / Memory / Initialization** if `agent/memory` is
        missing
     6. optionally run **Actions > Agent / Rubrics / Initialization** if the repo
        wants rubric steering and `agent/rubrics` is missing
   - Summarize post-merge auth options from the setup guide in the first next
     step: hosted app/OIDC, BYO GitHub App via `AGENT_APP_ID` +
     `AGENT_APP_PRIVATE_KEY`, `AGENT_PAT`, or fallback workflow token. Make the
     hosted Sepo GitHub App path the default recommendation. Keep this separate
     from the active token used to open this install PR.
   - Mention useful optional variables such as `AGENT_HANDLE`, `AGENT_RUNS_ON`,
     `AGENT_ACCESS_POLICY`, `AGENT_MEMORY_POLICY`, `AGENT_RUBRICS_POLICY`,
     `AGENT_SESSION_BUNDLE_MODE`, and `AGENT_STATUS_LABEL_ENABLED`.

7. Review and validate before commit.
   - Confirm the diff is limited to approved agent infrastructure:
     `git status --short`, `git diff --stat`, and
     `git diff -- .agent .github .skills AGENT.md`.
   - Run whitespace/staged checks:
     `git diff --check`, then stage intended files, then
     `git diff --cached --check`.
   - Because this install copies runtime code and workflow YAML, run when the
     target environment permits:
     `npm --prefix .agent ci`, `npm --prefix .agent run build`,
     `npm --prefix .agent test`, and YAML parsing for `.github/workflows/*.yml`.
   - If a check cannot run, report exactly why it was skipped.

8. Commit, push, and open the PR.
   - Commit message: `chore: install Sepo agent infrastructure`.
   - Stage only intended files, typically `.agent .github`, plus approved
     `.skills/<requested-skill>` and/or `AGENT.md`.
   - PR body should include source revision, installed files, conflict audit,
     preserved/skipped files, validation results, required secrets/variables,
     and the structured numbered setup section above. Keep the user-facing copy
     aligned with the onboarding status comment: GitHub App/auth, model
     credentials, memory, rubrics, remaining setup, and smoke-test commands.
     Clearly distinguish settings detected during the audit from todos the
     repository owner still needs to complete after merge.
   - Do not merge the PR unless explicitly asked.

## Post-Merge Guidance

After the install PR merges:

- Verify GitHub Actions are enabled and required secrets/auth settings are set.
- Run `Agent / Onboarding / Check Setup` and use the `Sepo setup check` issue as
  the source of truth for current GitHub auth, provider credential, memory, and
  rubrics status.
- Check for existing branches before initializing:
  `git ls-remote --heads https://github.com/<owner>/<repo>.git agent/memory agent/rubrics`.
- If `agent/memory` is missing, run or ask the owner to run
  `Agent / Memory / Initialization`; do not reinitialize an existing branch.
- If the repo wants rubric steering and `agent/rubrics` is missing, run or ask
  the owner to run `Agent / Rubrics / Initialization`; do not reinitialize an
  existing branch.
- Open a smoke-test issue mentioning `@sepo-agent /answer` or the
  configured `AGENT_HANDLE`.
- After branches exist, use ongoing memory workflows and `Agent / Rubrics /
  Update` for future learning.

## Final Response

Report the target repo/branch, source revision, PR URL or reason none was
opened, audit outcome, files installed/skipped/preserved/removed, validation
results including skipped checks, required setup still pending, and post-merge
memory/rubrics next steps.
