## Task Description

Run a Sepo agent infrastructure update check for this repository and open or
update a focused pull request only when the installed agent infrastructure
differs from the resolved Sepo source revision.

## Route Contract

- This prompt is used only for the first-class internal `update-agent` route.
- `REQUEST_TEXT` contains the workflow-resolved update inputs, including target
  repository, runtime checkout path, update target path, source repo/ref/SHA,
  existing update PR details, and optional update flags.
- The workflow has already resolved the source revision and pending update PR.
  Use those explicit values instead of re-resolving or inferring them from
  prose.
- This route must not depend on `.skills/update-agent/SKILL.md`; all behavior
  needed for scheduled/manual repository updates lives in this prompt and the
  checked-out runtime code.
- Do not post comments directly unless the update workflow instructions require
  it; return the concise workflow summary as the final response.

## Inputs

Confirm these before editing:

- target repository slug and default branch
- source agent repo/ref; if invoked from a target repo, default source slug is
  `self-evolving/repo` unless the workflow provides another source
- update branch name, defaulting to `agent/update-agent-infra-<yyyymmdd>`
- whether to update any `.skills/` directories; default is no
- whether root `AGENT.md` is agent-owned and should be updated; default is no
- whether obsolete/legacy agent files should be removed; default is no
- whether post-merge workflows should be dispatched by you or only documented

When invoked by Sepo's built-in `agent-update.yml` workflow, treat the workflow
request as that confirmation: the target repository is the current checkout or
the explicit update target path named in the request, the workflow has already
resolved `self-evolving/repo` to either the latest published stable release tag
or an explicit manual `source_ref`, optional `.skills/` and `AGENT.md` updates
default to no, obsolete-file removal defaults to no, and post-merge workflows
should be documented only unless the request explicitly says otherwise. If no
release exists yet, the workflow falls back to `main` and includes that fallback
in the run summary. The workflow skips before invoking this route only when
scheduling is disabled. When an `agent/update-agent-infra-*` PR is already open,
the workflow keeps its runtime checkout on the default branch, prepares that
branch as the update target, and includes the existing PR number, branch, target
path, and runtime checkout path in the request text. Update that existing PR in
the target path instead of opening a duplicate, and do not check out the
existing PR branch in the runtime checkout path. A manual `force=true` run
ignores the existing PR lookup and starts from the default branch. Scheduled
invocations are enabled by default and can be disabled with
`AGENT_AUTO_UPDATE=false`; manual dispatch remains available.

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
- When the request provides separate runtime checkout and update target paths,
  keep runtime workflow code on the runtime checkout path and edit the target
  branch only through the update target path.
- Do not include secret values in commits, PR bodies, or comments.

## Workflow

1. Read source setup docs first:
   - `.agent/docs/setup/install-existing-repository.md`
   - `.agent/docs/setup/setup-guide.md`

2. Prepare source and target checkouts.
   - Clone/open the target repo and keep it separate from the source repo.
   - If the request names an update target path, use that path for target edits.
   - If the request names an existing update PR branch without a separate target
     path, continue from that branch and update the existing PR.
   - Otherwise, create the update branch from the target default branch.
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
   - If the request names an existing update PR, push updates to that PR's
     branch and report the existing PR URL instead of opening another PR.
   - PR title and body should clearly say
     `Update Sepo from <installed version/ref> to <resolved source ref/sha>`.
     The body should also include source repo/ref, target branch, changed path
     groups, audit summary, customizations preserved, removed files with
     confirmation, memory/rubrics branch status, validation results, and
     post-merge notes.
   - Do not merge the PR unless explicitly asked.

## Post-Merge Guidance

Temporary migration note: if this is a one-time refresh PR for a repository
whose current `agent-update.yml` still invokes `.skills/update-agent/SKILL.md`,
say that the PR bootstraps future dedicated-route updates. Do not add this note
to durable user docs, and remove this temporary prompt guidance after affected
installs have refreshed.

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
- Run a smoke-test issue mentioning `@sepo-agent /answer` or the configured
  `AGENT_HANDLE`.

## Final Response

Report the target repo/update branch, source repo/ref, PR URL or reason none was
opened, audit outcome, files updated/skipped/preserved/removed, memory/rubrics
branch status, validation results including skipped checks, and post-merge
workflow commands or dispatch results.
