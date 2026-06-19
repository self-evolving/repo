---
title: "Agent actions"
---

Agent actions are route-level behaviors exposed by the `.agent` backend. They are selected by the router from mentions, labels, approval comments, or direct workflow dispatch.

| Agent action | Route | Typical prompt or skill source | Execution path |
|---|---|---|---|
| Answer | `answer` | `.github/prompts/agent-answer.md` | inline response through `agent-router.yml`; review-triggered answers may post targeted inline replies |
| Implement | `implement` | `.github/prompts/agent-implement.md` | explicit `/implement` or `agent/implement` label dispatches `agent-implement.yml` directly; triaged implement goes through approval first |
| Add rubrics | `add-rubrics` | `.github/prompts/agent-add-rubrics.md` | implementation-like proposal flow that branches from `agent/rubrics`, keeps Sepo runtime on the default branch, and opens a draft PR targeting `agent/rubrics` |
| Fix PR | `fix-pr` | `.github/prompts/agent-fix-pr.md` | PR-only dispatch to `agent-fix-pr.yml` |
| Review | `review` | `.github/prompts/review.md` and `.github/prompts/review-synthesize.md` | parallel review jobs plus synthesis in `agent-review.yml` |
| Orchestrate | `orchestrate` | `.github/prompts/agent-orchestrator.md` | explicit `/orchestrate`, `agent/orchestrate`, or dispatch-triaged issue/PR requests dispatch `agent-orchestrator.yml`, which selects the next action based on current target state |
| Self approve | `agent-self-approve` | `.github/prompts/agent-self-approve.md` | opt-in PR approval gate in `agent-self-approve.yml`; deterministic code submits a review approval or records an internal approval status only after current-head checks pass |
| Self merge | `agent-self-merge` | deterministic resolver | opt-in PR merge gate in `agent-self-merge.yml`; deterministic code merges only after current-head self-approval review/status, checks, mergeability, and requested-change guards pass |
| Create action | `create-action` | `.github/prompts/agent-create-action.md` | implementation PR that adds or updates a standalone scheduled workflow under `.github/workflows/` |
| Skill | `skill` | `<skill_root>/<name>/SKILL.md` | inline skill route through `agent-router.yml`; optional `<skill_root>/<name>/setup.sh` hook |
| Install | `install` | `.github/prompts/agent-install.md` | first-class `/install` route or install request issue form for authorization; runs the dedicated install prompt with the install-only token |
| Update agent | `update-agent` | `.github/prompts/agent-update.md` | internal route used by `agent-update.yml` to update installed Sepo infrastructure without depending on installed skills |
| Dispatch | `dispatch` | `.github/prompts/agent-dispatch.md` | route triage inside `agent-router.yml` |

The orchestrator is now a top-level route. Users start orchestration explicitly with `/orchestrate` or `agent/orchestrate`; dispatch triage can also select `orchestrate` for issue and pull request requests that ask for orchestration, follow-up automation, or bounded multi-step agent work. `agent-orchestrator.yml` chooses follow-up work from current target state. Workflows launched by the orchestrator carry explicit orchestration context and hand back after post-processing, so the bounded `implement -> review -> fix-pr -> review` loop can continue until a stop condition. Direct `/implement`, `/review`, and `/fix-pr` runs do not carry that context and stay one-shot. In `heuristics` mode, PR orchestrate starts use deterministic status routing. In `agent` mode, issue and PR orchestrate starts invoke the planner. For small self-contained issue work, the planner can hand off directly to `implement` on the current issue. For PR work, the planner can choose `review`, `fix-pr`, `answer`, or stop/block; runtime policy validates that PR starts dispatch only `review` or `fix-pr`. For meta-orchestration, child work uses the internal `delegate_issue` decision to create, reuse, or adopt a child issue that then runs the normal `/orchestrate` flow. `delegate_issue` is not a public route and is not part of `AgentAction`. Planner handoffs can carry `handoff_context`; `fix-pr` receives that context as explicit initial steering for the automated fix pass.

For normal `/answer` runs, the agent returns a reply body and `agent-router.yml`
posts it on the triggering surface. When the trigger source is
`pull_request_review`, the answer prompt receives the review id and URL as
conditional context. In that case, the agent may inspect the triggering review
and related inline comments with `gh`, then post targeted inline replies when
the user asked for that shape. It still returns a non-empty answer body for the
normal post step and should skip duplicate Sepo-authored inline replies on
reruns.

Implementation runs can create stacked PRs by receiving either `base_branch` or
`base_pr`. `base_pr` resolves to the open same-repository PR head branch; when
neither input is set, implementations branch from the repository default branch.
For explicit `/implement` requests on pull requests, the router can obtain
`base_pr` from the metadata-only tracking issue prompt when the current request
asks for stacked or follow-up implementation work. If that inferred source PR is
closed or merged, the router drops `base_pr` so the implementation starts from
the default branch; the tracking issue still links the closed PR as context.

The `add-rubrics` route reuses the implementation workflow with
`base_branch=agent/rubrics` and the dedicated add-rubrics prompt. Because the
rubrics branch is a data branch, the workflow keeps the Sepo runtime checkout on
the repository default branch and runs the agent in a separate rubrics worktree.
Successful runs open a draft proposal PR against `agent/rubrics`.

## Consumption model

Agent actions share the same runtime shape:

1. A trigger enters a workflow and converges on `agent-router.yml` or a route-specific workflow.
2. The route chooses a prompt name or skill name.
3. `.github/actions/run-agent-task` builds a runtime envelope with route, target, source, request, lane, and session-policy metadata.
4. The runtime prepends `.github/prompts/_base.md` to the selected prompt, substitutes prompt variables, and runs the selected `acpx` agent.
5. Post-processing steps parse the response, post comments, create branches, create PRs, or update the existing PR branch depending on the route.

The shared base prompt defines the common metadata and context-gathering contract. Route prompts should focus on route-specific behavior and should not duplicate the base metadata header.

## Scheduled action workflows

Durable actions are repository-owned GitHub Actions workflows under
`.github/workflows/`. They are proposed through normal implementation pull
requests, reviewed by humans, and only become runnable after merge to the default
branch.

The `create-action` route creates or updates one standalone workflow, usually
named `agent-action-<short-slug>.yml`. Generated workflows use native
`schedule`/`workflow_dispatch` triggers and the existing shared runtime actions
(`resolve-github-auth`, `resolve-agent-provider`, `setup-agent-runtime`, and
`run-agent-task`). The template includes the same `AGENT_ENABLED=false` job
guard as packaged Sepo workflows. GitHub does not expire scheduled workflows
automatically, so generated scheduled workflows use
`.github/actions/check-agent-action-expiration` and skip provider setup/agent
execution once expired.

The built-in `agent-update.yml` workflow is the default recurring maintenance
path for Sepo itself. It runs near-biweekly, resolves the update source to the
latest published stable Sepo release tag, runs the dedicated `update-agent`
route, and opens an update PR only when the target repository differs from that
source. Manual dispatch can pass `source_ref` to test `main`, a branch, or a
specific tag. If no release exists yet, the workflow falls back to `main` and
records that fallback in the run summary. A pre-runtime pending-PR resolver
adopts an open same-repository `agent/update-agent-infra-*` PR by preparing its
branch as the update target while keeping workflow runtime code on the default
branch, then instructing the update route to update that PR instead of opening a
duplicate. Set `AGENT_AUTO_UPDATE=false` to disable scheduled update checks
while keeping manual dispatch available; the canonical `self-evolving/repo`
source repository should use that setting instead of relying on a workflow-level
repository special case.

## Self-documenting pattern

The desired source of truth for generated agent-action docs is a pair of small metadata blocks: one near the workflow wiring and one near the prompt.

Workflow metadata should describe routing, execution, and session behavior:

```yaml
# agent-doc:
#   kind: agent-action
#   action: implement
#   title: Implement
#   route: implement
#   summary: Creates a branch, commits approved changes, and opens a draft PR.
#   workflow: .github/workflows/agent-implement.yml
#   prompt: .github/prompts/agent-implement.md
#   session_policy: track-only
#   lane: default
#   dispatch:
#     trigger: approval
#     approval_required: true
#   post_processing:
#     - verify changes
#     - parse structured response
#     - commit and push
#     - create pull request
```

Prompt metadata should describe the model-facing contract:

```md
<!-- agent-doc:
kind: prompt
action: implement
source: .github/prompts/agent-implement.md
base_prompt: .github/prompts/_base.md
consumes:
  - REPO_SLUG
  - TARGET_KIND
  - TARGET_NUMBER
  - TARGET_URL
  - SOURCE_KIND
  - REQUEST_TEXT
produces:
  - summary
  - commit_message
  - pr_title
  - pr_body
-->
```

The renderer should combine workflow metadata, prompt metadata, and runtime metadata into generated per-action docs. Until then, this page is the canonical overview for agent actions.

## Rendering expectations

A future docs generator should:

- scan `.github/workflows/agent-*.yml` for `kind: agent-action`
- scan `.github/prompts/*.md` for `kind: prompt`
- validate that every documented route has a workflow, prompt or skill source, session policy, and post-processing description
- render an overview table and optional per-action pages
- keep generated files separate from hand-written architecture pages

The generator should not infer user-facing behavior only from raw workflow YAML. Workflow YAML should remain operational source code; `agent-doc` metadata should provide stable documentation intent.
