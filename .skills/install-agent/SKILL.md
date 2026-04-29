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
- source agent repo/ref, defaulting to the current checkout
- install branch name, defaulting to `agent/install-agent-infra`
- preferred GitHub auth path: hosted app/OIDC, bring-your-own GitHub App,
  `AGENT_PAT`, or fallback workflow token
- model provider secret plan: `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or both
- whether to copy any `.skills/` directories; default is no
- whether to copy root `AGENT.md`; default is no

Stop if the target repo, branch, or source revision is ambiguous.

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

2. Prepare the target checkout.
   - Clone/open the target repo.
   - Create the install branch from the target default branch.
   - Check `git status --short`; stop if unrelated local changes would make the
     install ambiguous.

3. Audit before copying.
   - Inspect every path in **Agent-Owned Scope**.
   - Check related branches/refs:
     `git ls-remote --heads origin agent/memory agent/rubrics 'agent/*'`.
   - Check existing secrets/variables/workflows where permissions allow:
     `gh secret list`, `gh variable list`, and `gh workflow list`.
   - Look for legacy or overlapping scaffolds such as `.flows/`, `.claude/`, old
     `run-claude-task` / `run-codex-task` actions, or stale `agent-*` workflows.
   - Classify overlaps as absent, identical, agent-owned divergent,
     repo-owned/custom, or legacy removal candidate.
   - Present the audit in a small table and ask before replacing divergent files
     or removing anything.

4. Copy the install files conservatively.
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

5. Configure target repository guidance.
   - Do not commit secret values.
   - In the PR body, tell the owner to configure at least one provider secret:
     `OPENAI_API_KEY` and/or `CLAUDE_CODE_OAUTH_TOKEN`.
   - Summarize auth options from the setup guide: hosted app/OIDC, BYO GitHub App
     via `AGENT_APP_ID` + `AGENT_APP_PRIVATE_KEY`, `AGENT_PAT`, or fallback
     workflow token.
   - Mention useful optional variables such as `AGENT_HANDLE`, `AGENT_RUNS_ON`,
     `AGENT_ACCESS_POLICY`, `AGENT_MEMORY_POLICY`, `AGENT_RUBRICS_POLICY`,
     `AGENT_SESSION_BUNDLE_MODE`, and `AGENT_STATUS_LABEL_ENABLED`.

6. Review and validate before commit.
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

7. Commit, push, and open the PR.
   - Commit message: `chore: install Sepo agent infrastructure`.
   - Stage only intended files, typically `.agent .github`, plus approved
     `.skills/<requested-skill>` and/or `AGENT.md`.
   - PR body should include source revision, installed files, conflict audit,
     preserved/skipped files, validation results, required secrets/variables,
     and post-merge setup notes.
   - Do not merge the PR unless explicitly asked.

## Post-Merge Guidance

After the install PR merges:

- Verify GitHub Actions are enabled and required secrets/auth settings are set.
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
