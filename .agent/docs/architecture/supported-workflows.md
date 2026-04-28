# Supported workflows

## Workflow reference

### Core workflows

| Workflow | Trigger | Purpose | Model |
|---|---|---|---|
| `agent-label.yml` | `issues.labeled`, `pull_request_target.labeled` | Thin entry point for label-based activation into `agent-router.yml` | None |
| `agent-entrypoint.yml` | `@sepo-agent` in issues, PRs, discussions, comments, reviews | Thin entry point that wires triggers, runner labels, and secrets into `agent-router.yml` | None |
| `agent-router.yml` | `workflow_call` | Full portal for context extraction, auth gating, mention detection, dispatch triage, routing, approval requests, and response posting | Configurable |
| `agent-approve.yml` | approval comments | Resolves pending approvals, creates issues when needed, dispatches implementation | None |
| `agent-orchestrator.yml` | `workflow_dispatch` | Post-action automation layer that decides whether to dispatch the next action | None in `heuristics` mode; resolved-provider planner in `agent` mode |
| `agent-implement.yml` | `workflow_dispatch` | Implementation flow: branch, commit, draft PR | Auto |
| `agent-fix-pr.yml` | `workflow_dispatch`, `workflow_call` | PR fix flow: update existing PR branch, verify, push | Auto |
| `agent-review.yml` | `workflow_dispatch`, `workflow_call` | Parallel Claude and Codex review with resolved-provider synthesis, plus a separate rubric review comment | Claude + Codex reviewers; configurable synthesis |
| `agent-branch-cleanup.yml` | `pull_request_target.closed` | Event-driven cleanup of agent-created branches after PR close. Excludes the shared `agent/memory` and `agent/rubrics` branches. | None |
| `agent-close-stale-issues.yml` | `schedule` (daily), `workflow_dispatch` | Closes open `agent` issues that have had no activity for 30 days by default | None |
| `agent-daily-summary.yml` | `schedule` (daily), `workflow_dispatch` | Generates a concise repository activity summary and posts it as a Discussion | Auto |
| `test-scripts.yml` | `pull_request`, `workflow_dispatch` | CI for helper tests, YAML parsing, and shell syntax | None |

When `AGENT_AUTOMATION_MODE=heuristics` (or the compatibility alias `true`),
`agent-implement.yml`, `agent-review.yml`, and `agent-fix-pr.yml` hand back to
`agent-orchestrator.yml` after their normal post-processing. `heuristics` mode
runs the built-in `implement -> review -> fix-pr -> review` state machine.
`agent` mode runs an orchestrator planner with its own session context, then
validates the planner's JSON decision against the same built-in transition
policy before dispatching with `workflow_dispatch`. The planner can include a
`handoff_context` string for the next action; `fix-pr` receives it as explicit
initial steering when the planner dispatches a PR-fix pass. The planner mounts memory
and rubrics read-only so automated control-flow planning can use steering
context without mutating those state branches. Loops stop when the review
verdict is `SHIP`, a route fails, a duplicate handoff marker is found, the
planner stops or blocks, or the max-round budget is exhausted.

When a new review synthesis is posted to a pull request, the review workflow
first minimizes prior visible review synthesis comments and reviews from the
same authenticated agent account as outdated. Generated summaries carry a hidden
HTML marker for robust matching, with a heading fallback for older summaries.
This keeps the latest synthesis prominent while leaving older generated
summaries expandable. Set `AGENT_COLLAPSE_OLD_REVIEWS=false` to skip this
cleanup and leave prior review summaries visible.

### Repository memory workflows

| Workflow | Actions name | Trigger | Purpose | Model |
|---|---|---|---|---|
| `agent-memory-bootstrap.yml` | `Agent / Memory / Initialization` | `workflow_dispatch` | Seed the `agent/memory` branch on first run, then perform the initial sync and scan inline | Auto |
| `agent-memory-sync.yml` | `Agent / Memory / Sync GitHub Artifacts` | `schedule` (every 6h), `workflow_dispatch` | Deterministic mirror of issues, PRs, and discussions into the `agent/memory` branch | None |
| `agent-memory-pr-closed.yml` | `Agent / Memory / Record PR Closure` | `pull_request_target.closed`, `workflow_dispatch` | Agent-driven memory curation run triggered when a PR closes. Skips unmerged fork PRs. | Auto |
| `agent-memory-scan.yml` | `Agent / Memory / Curate Recent Activity` | `schedule` (every 6h), `workflow_dispatch` | Scheduled agent-driven memory curation across recent repository activity | Auto |

The `agent-memory-*` workflows and the `agent/memory` branch they share are documented in [Repository memory](./memory.md), including the layout, the `AGENT_MEMORY_POLICY` configuration, and per-route permission rules.

### User/team rubrics workflows

| Workflow | Actions name | Trigger | Purpose | Model |
|---|---|---|---|---|
| `agent-rubrics-initialization.yml` | `Agent / Rubrics / Initialization` | `workflow_dispatch` | Creates `agent/rubrics`, seeds the layout, and optionally populates initial rubrics from supplied context or repository history | Auto |
| `agent-rubrics-review.yml` | `Agent / Rubrics / Review` | `workflow_dispatch`, `workflow_call` | Scores a PR against active rubrics selected from `agent/rubrics` | Auto |
| `agent-rubrics-update.yml` | `Agent / Rubrics / Update` | merged `pull_request_target.closed`, `workflow_dispatch` | Learns durable user/team preferences from PR interactions and updates `agent/rubrics` | Auto |

Rubrics are documented in [User/team rubrics](./rubrics.md). They are separate from repository memory: memory is agent/project continuity, while rubrics are normative user/team preferences used to steer implementation and evaluate reviews.

`agent-branch-cleanup.yml` and `agent-close-stale-issues.yml` are standalone
workflows. They listen directly to repository events or schedules and apply
their guardrails in place.

Single-agent routes, autonomous agent workflows, and the review synthesis step resolve their provider before installing provider CLIs. Explicit provider choices from `AGENT_DEFAULT_PROVIDER` or a route-specific override are authoritative: the workflows select that provider even when the matching repository secret is absent, so self-hosted runners can rely on local Codex or Claude authentication. When the provider is `auto`, detection uses configured provider secrets and prefers Codex when both `OPENAI_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are present. Route-specific overrides are available by editing the relevant workflow's `resolve-agent-provider` step inline. Portal and skill jobs use non-fatal early resolution before non-agent response paths, then require a provider only immediately before invoking an agent.

## Trigger details

### `agent-entrypoint.yml`

The broad pre-filter is `contains(toJSON(github.event), '@sepo-agent')`. Real mention validation happens in `agent-router.yml` through `extract-context.js`. That validation is boundary-aware and strips code blocks and quoted text before deciding whether a mention is live.

Supported surfaces:

| Event | Surfaces checked |
|---|---|
| `issues` | issue title, issue body |
| `issue_comment` | comment body |
| `pull_request` | PR title, PR body |
| `pull_request_review_comment` | comment body |
| `pull_request_review` | review body |
| `discussion` | discussion title, discussion body |
| `discussion_comment` | comment body |

By default, the portal responds to `OWNER`, `MEMBER`, `COLLABORATOR`, and `CONTRIBUTOR` associations. `AGENT_ACCESS_POLICY` can tighten or widen access globally or for specific routes; public repositories that do not want prior contributors to trigger Sepo should remove `CONTRIBUTOR` from the allowlist. Bot authors are always skipped. Implicit mentions are triaged first and then checked against the resolved route, so denied requests get a visible unsupported reply instead of being dropped silently. See [Trigger access policy](../access-policy.md).

Explicit routes are:

- `@sepo-agent /answer`
- `@sepo-agent /implement`
- `@sepo-agent /create-action`
- `@sepo-agent /fix-pr`
- `@sepo-agent /review`
- `@sepo-agent /skill <name>`

Explicit routes skip dispatch triage and resolve locally, but still go through the same route policy checks afterward.

Mention-based skill requests normalize the skill name to lowercase and run `.skills/<name>/SKILL.md` inline through the same `skill` route used by `agent/s/<skill>` labels.

### `agent-label.yml`

Applying one of these labels triggers the same downstream routing stack without requiring a live mention:

- `agent/answer`
- `agent/implement`
- `agent/create-action`
- `agent/fix-pr`
- `agent/review`
- `agent/s/<skill>`

After a label-triggered request is accepted by the router, `agent-label.yml` removes the triggering `agent/*` label so label-based runs behave like one-shot queue entries, including policy-denied requests that resolve to `unsupported`.

Built-in labels map directly to the existing routes. `agent/s/<skill>` runs `.skills/<skill>/SKILL.md` inline; if the skill file is missing, the runner posts a visible fallback comment instead of silently skipping the label.

If `AGENT_STATUS_LABEL_ENABLED=true`, accepted non-unsupported issue and pull request requests also get the fixed `agent` status label. This status label is separate from the `agent/*` trigger labels and does not select a route.

Label triggers authorize the label applier rather than the issue or pull request author. Personal-repository owners map to `OWNER`; visible organization members map to `MEMBER`; repository collaborators with label permission map to `COLLABORATOR`.

Skill names are normalized to lowercase, so `agent/s/Release-Notes` resolves to `.skills/release-notes/SKILL.md`. Skill directories should use lowercase names to match consistently across case-sensitive filesystems.

### `agent-approve.yml`

Approval comments on issues or discussions are matched by `@sepo-agent /approve <request_id>`. The workflow finds the unresolved request marker, creates an issue when required, and dispatches the encoded workflow.

The pending request data lives in a `<!-- sepo-agent-request ... -->` marker. Approval comments are checked against `AGENT_ACCESS_POLICY` using the route stored in that marker. For `implement` routes from non-issue surfaces, approval creates the issue from the marker's `issue_title` and `issue_body` before dispatching.
