---
name: update-agent
description: Upgrade an existing Sepo agent installation in another GitHub repository through a focused pull request. Use when asked to refresh, sync, or update installed agent infrastructure while preserving repo-owned customizations, validating the diff, and checking post-merge memory/rubrics state.
---

# Update Agent

Use this skill to update an existing Sepo agent installation in a target
repository. Deliver the update as a normal PR that preserves target-owned code,
CI, prompts, skills, memory, rubrics, and local conventions unless the user
explicitly approves a change.

## Inputs

Confirm these before editing:

- target repository slug and default branch
- source agent repo/ref; if invoked from a target repo, default source slug is
  `self-evolving/repo` unless the user provides another source
- update branch name, defaulting to `agent/update-agent-infra-<yyyymmdd>`
- whether to update any `.skills/` directories; default is no
- whether root `AGENT.md` is agent-owned and should be updated; default is no
- whether obsolete/legacy agent files should be removed; default is no
- whether post-merge workflows should be dispatched by you or only documented

When invoked by Sepo's built-in `agent-update.yml` workflow, treat the workflow
request as that confirmation: the target repository is the current checkout,
the default source is `self-evolving/repo@main`, optional `.skills/` and
`AGENT.md` updates default to no, obsolete-file removal defaults to no, and
post-merge workflows should be documented only unless the request explicitly
says otherwise. The workflow skips before invoking this skill when an
`agent/update-agent-infra-*` PR is already open, unless the manual run uses
`force=true`.

Stop if the target repo, installed agent scaffold, or source revision is
ambiguous.

## Agent-Owned Scope

Update only installed agent infrastructure:

- `.agent/`, excluding generated/dependency directories
- the source repo's `.github/` agent assets as a set, merged into the target
  `.github/` without deleting target-only content:
  - workflows, actions, prompts, and scripts/functions under source `.github/`
  - source prompt `.md` files copied by file name while preserving target-only
    prompts
  - existing target workflows, actions, prompts, scripts/functions, or other
    `.github` files preserved unless explicitly approved for replacement
- optional `.skills/<requested-skill>/SKILL.md`, only with explicit approval
- optional `AGENT.md`, only when agent-owned or explicitly approved

Do not update target application source, repository secrets, branch protection,
memory/rubrics branch content, target-owned `.github` functionality, or the
target root `README.md` unless explicitly requested.

## Guardrails

- Never push directly to the target default branch or merge the PR unless asked.
- Never rewrite or delete `agent/memory`, `agent/rubrics`, or
  `refs/agent-state/*`.
- Never overwrite target customizations or remove target-only files without
  showing an audit and getting confirmation.
- Preserve target-only `.github` files, target `.skills/`, target-only prompts,
  and repo-owned `AGENT.md` by default.
- Do not use `rsync --delete` on `.github/`, `.github/prompts/`, or `.skills/`.
  `rsync --delete` is acceptable only inside `.agent/` after approval.
- Do not copy generated or local-only files: `node_modules/`, `dist/`,
  `.agent/node_modules/`, `.agent/dist/`, `.git/`, `_worktrees/`, or
  `.claude/worktrees/`.
- Merge agent-generated-output ignore rules into the target's existing
  `.gitignore` instead of replacing it: at least `.agent/dist/` and
  `.agent/node_modules/`.
- Do not include secret values in commits, PR bodies, or comments.

## Workflow

1. Read source deployment docs first:
   - `.agent/docs/deployment/install-existing-repository.md`
   - `.agent/docs/deployment/setup-guide.md`

2. Prepare source and target checkouts.
   - Clone/open the target repo and keep it separate from the source repo.
   - Create the update branch from the target default branch.
   - Check `git status --short`; stop if unrelated local changes would make the
     update ambiguous.

3. Audit installed files, branches, and legacy scaffolds.
   - Inspect every path in **Agent-Owned Scope**.
   - Preserve branch/ref state:
     `git ls-remote --heads origin agent/memory agent/rubrics 'agent/*'` and,
     if relevant, `git ls-remote origin 'refs/agent-state/*'`.
   - Compare source and target for `.agent/` and `.github/` agent assets.
   - Look for legacy or overlapping scaffolds such as `.flows/`, `.claude/`, old
     `run-claude-task` / `run-codex-task` actions, `agent-local.yml`,
     `agent-runner.yml`, or stale Claude/Codex workflows.
   - Classify each item as safe add, clean replace, needs confirmation,
     target-owned preserve, or candidate removal.
   - Present the audit in a small table and ask before replacing customizations
     or removing anything.

4. Apply the update conservatively.
   - Sync `.agent/` with generated/dependency exclusions.
   - Preserve target-owned root files, but add the agent ignore entries
     `.agent/dist/` and `.agent/node_modules/` to the target `.gitignore` if
     missing so GitHub-hosted runner builds do not leak generated files into PRs.
   - Copy all source `.github/` files/directories into the target `.github/` by
     default, but merge rather than wholesale replace.
   - Preserve target-only `.github` files and replace existing `.github` files
     only when they are identical, clearly agent-owned, or explicitly approved.
   - Copy source prompt `.md` files without deleting target-only prompts;
     manually merge local prompt customizations if needed.
   - Update requested `.skills/` directories and `AGENT.md` only when approved.
   - Remove obsolete/legacy files only when explicitly approved, and list every
     removal in the PR body.

5. Review and validate before commit.
   - Confirm the diff is limited to approved agent infrastructure:
     `git status --short`, `git diff --stat`, and
     `git diff -- .agent .github .skills AGENT.md`.
   - Run whitespace/staged checks:
     `git diff --check`, then stage intended files, then
     `git diff --cached --check`.
   - Because this update changes runtime code and workflow YAML, run when the
     target environment permits:
     `npm --prefix .agent ci`, `npm --prefix .agent run build`,
     `npm --prefix .agent test`, and YAML parsing for `.github/workflows/*.yml`.
   - If tests fail because of target-specific environment limitations, report
     the failure and explain whether the PR is safe to continue.
   - If a check cannot run, report exactly why it was skipped.

6. Commit, push, and open the PR.
   - Commit message: `chore: update Sepo agent infrastructure`.
   - Stage only intended files, typically `.agent .github`, plus approved
     `.skills/<requested-skill>` and/or `AGENT.md`.
   - If the update produces no file changes, do not create a branch or PR;
     report that the target is already current.
   - PR body should include source repo/ref, target branch, changed path groups,
     audit summary, customizations preserved, removed files with confirmation,
     memory/rubrics branch status, validation results, and post-merge notes.
   - Do not merge the PR unless explicitly asked.

## Post-Merge Guidance

After the update PR merges:

- Verify required secrets/auth settings still match the updated workflows.
- Check branches:
  `git ls-remote --heads https://github.com/<owner>/<repo>.git agent/memory agent/rubrics`.
- If `agent/memory` exists, do not reinitialize it; prefer ongoing sync/scan
  workflows. If it is missing because this was effectively a first install, run
  `Agent / Memory / Initialization`.
- If `agent/rubrics` exists, do not reinitialize it. If it is missing and the
  repo wants rubrics, run `Agent / Rubrics / Initialization`.
- Optionally run `Agent / Rubrics / Update` for the merged update PR if the user
  wants to distill review feedback about the agent update.
- Run a smoke-test issue mentioning `@sepo-agent /answer` or the
  configured `AGENT_HANDLE`.

## Final Response

Report the target repo/update branch, source repo/ref, PR URL or reason none was
opened, audit outcome, files updated/skipped/preserved/removed, memory/rubrics
branch status, validation results including skipped checks, and post-merge
workflow commands or dispatch results.
