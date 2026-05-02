---
name: distill-rubrics
description: Distill durable user or team rubric preferences from local agent execution histories, repository discussions, and existing agent/rubrics content. Use when asked to mine prior agent work, compare candidate preferences with current rubrics, and open a PR that adds or updates rubric YAML on the agent/rubrics branch.
---

# Distill Rubrics

Use this skill to turn prior agent execution evidence into durable user/team rubrics.
The output is a pull request whose base branch is `agent/rubrics`.

## Workflow

1. Determine the repository slug and rubrics ref.
   - Default rubrics ref: `agent/rubrics`.
   - Honor `AGENT_RUBRICS_REF` when it is set.
   - Confirm the branch exists with `git ls-remote --heads origin "${AGENT_RUBRICS_REF:-agent/rubrics}"`.
   - If the branch does not exist, stop and report that rubric initialization must run first.

2. Search local agent execution histories for this project.
   - Prefer project-scoped evidence. Filter by repo slug, repo path, PR number, issue number, or branch name before trusting a hit.
   - Search likely local history roots when they exist:
     - `~/.codex/sessions/**/*.jsonl`
     - `~/.acpx/sessions/*.json`
     - `~/.acpx/sessions/*.stream.ndjson`
     - `~/.claude/projects/**/*.jsonl`
   - Also inspect mounted memory or history artifacts when present, especially `${MEMORY_DIR}/github/*.json`.
   - Useful search terms include `rubric`, `preference`, `prefer`, `always`, `never`, `must`, `should`, `avoid`, `review`, `style`, and `workflow`.

3. Convert history hits into durable evidence.
   - Treat local histories as discovery, not final proof.
   - For each promising hit, find the corresponding GitHub issue, PR, review, or comment with `gh`.
   - Prefer stable URLs in `examples[].source`, such as PR review comments or issue comments.
   - Do not learn rubrics from agent-authored summaries unless a trusted human explicitly endorsed the preference.

4. Read the existing rubrics before editing.
   - Create a temporary worktree or checkout rooted at the rubrics ref.
   - Read every active rubric under `rubrics/`.
   - Validate with `.agent/dist/cli/rubrics/validate.js --dir <rubrics-worktree>` when the project runtime is built.
   - Prefer updating an existing rubric over creating a near-duplicate.

5. Decide whether a rubric change is warranted.
   - Add or update a rubric only when trusted evidence shows a durable preference future agents should follow or be evaluated against.
   - Trust owner, admin, maintain, member, or collaborator feedback more than drive-by comments.
   - Skip one-off remarks, speculative ideas, repository facts, and preferences already covered by an active rubric.
   - Use `status: draft` when the preference is plausible but not yet strongly established.

6. Branch from the rubrics ref and edit only rubric files.
   - Create a branch such as `rubrics/distill-<short-topic>` from `origin/agent/rubrics`.
   - Store one rubric per YAML file under `rubrics/<area>/`.
   - Keep directory names organizational; schema fields are the source of truth.
   - Do not edit repository source files in the rubrics worktree.

7. Validate, commit, push, and open a PR.
   - Run rubric validation before committing.
   - Commit only the rubric YAML or rubrics README changes needed for the distilled preference.
   - Push the branch and open a PR with `gh pr create --base "${AGENT_RUBRICS_REF:-agent/rubrics}" --head <branch>`.
   - Do not merge the PR unless the user explicitly asks.

## Rubric Schema

```yaml
schema_version: 1
id: kebab-case-stable-id
title: Short human-readable title
description: >-
  The durable user/team preference future agents should follow or be evaluated
  against.
type: generic
domain: coding_workflow
applies_to:
  - implement
severity: should
weight: 3
status: active
examples:
  - source: https://github.com/owner/repo/pull/123#discussion_r123456789
    note: Specific trusted comment that demonstrates why this rubric exists.
```

Allowed domains are `coding_style`, `coding_workflow`, `communication`, and `review_quality`.
Allowed routes are `answer`, `implement`, `add-rubrics`, `create-action`, `fix-pr`, `review`, `skill`, `rubrics-review`, `rubrics-initialization`, and `rubrics-update`.
Allowed severities are `must`, `should`, and `consider`; reserve `must` for clear repeated requirements.

## Final Response

Report:

- rubrics branch checked
- local history sources searched
- candidate preferences considered
- rubric files created or updated
- validation result
- PR URL, or `no rubric changes` when no durable preference was found
