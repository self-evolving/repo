# Agent actions

Agent actions are route-level behaviors exposed by the `.agent` backend. They are selected by the router from mentions, labels, approval comments, or direct workflow dispatch.

| Agent action | Route | Typical prompt or skill source | Execution path |
|---|---|---|---|
| Answer | `answer` | `.github/prompts/agent-answer.md` | inline response through `agent-router.yml` |
| Implement | `implement` | `.github/prompts/agent-implement.md` | explicit `/implement` or `agent/implement` label dispatches `agent-implement.yml` directly; triaged implement goes through approval first |
| Fix PR | `fix-pr` | `.github/prompts/agent-fix-pr.md` | PR-only dispatch to `agent-fix-pr.yml` |
| Review | `review` | `.github/prompts/review.md` and `.github/prompts/review-synthesize.md` | parallel review jobs plus synthesis in `agent-review.yml` |
| Create action | `create-action` | `.github/prompts/agent-create-action.md` | implementation PR that adds or updates a standalone scheduled workflow under `.github/workflows/` |
| Skill | `skill` | `.skills/<name>/SKILL.md` | inline skill route through `agent-router.yml` |
| Dispatch | `dispatch` | `.github/prompts/agent-dispatch.md` | route triage inside `agent-router.yml` |

When automation mode is enabled, action workflows hand back to `agent-orchestrator.yml` after normal post-processing. The orchestrator is a separate post-action control workflow rather than a user-selectable slash route. `heuristics` mode uses the built-in state machine. `agent` mode runs a scoped planner prompt with its own session context, then validates the planner's JSON decision against the same runtime policy before dispatching. Planner handoffs can carry `handoff_context`; `fix-pr` receives that context as explicit initial steering for the automated fix pass.

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
`run-agent-task`). GitHub does not expire scheduled workflows automatically, so
generated scheduled workflows use `.github/actions/check-agent-action-expiration`
and skip provider setup/agent execution once expired.

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
