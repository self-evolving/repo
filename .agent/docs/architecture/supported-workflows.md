# Supported workflows

## Workflow reference

### Core workflows

| Workflow | Trigger | Purpose | Model |
|---|---|---|---|
| `agent-label.yml` | `issues.labeled`, `pull_request_target.labeled` | Thin entry point for label-based activation into `agent-router.yml` | None |
| `agent-entrypoint.yml` | `@sepo-agent` in issues, PRs, discussions, comments, reviews | Thin entry point that wires triggers, runner labels, and secrets into `agent-router.yml` | None |
| `agent-router.yml` | `workflow_call` | Full portal for context extraction, auth gating, mention detection, dispatch triage, routing, approval requests, and response posting | Configurable |
| `agent-approve.yml` | approval comments | Resolves pending approvals, creates issues when needed, dispatches implementation | None |
| `agent-orchestrator.yml` | `workflow_dispatch` | Explicit orchestration route that decides whether to dispatch the next action | None in `heuristics` mode; resolved-provider planner in `agent` mode |
| `agent-implement.yml` | `workflow_dispatch` | Implementation flow: branch, commit, draft PR; supports `base_branch` or `base_pr` for stacked PRs | Auto |
| `agent-fix-pr.yml` | `workflow_dispatch`, `workflow_call` | PR fix flow: update existing PR branch, verify, push | Auto |
| `agent-review.yml` | `workflow_dispatch`, `workflow_call` | Parallel Claude and Codex review with resolved-provider synthesis, plus a separate rubric review comment | Claude + Codex reviewers; configurable synthesis |
| `agent-self-approve.yml` | `workflow_dispatch` | Opt-in final PR approval gate after review ships; gated by `AGENT_ALLOW_SELF_APPROVE` | Auto |
| `agent-branch-cleanup.yml` | `pull_request_target.closed` | Event-driven cleanup of merged agent-created branches after retargeting open stacked PRs. Excludes the shared `agent/memory` and `agent/rubrics` branches. | None |
| `agent-close-stale-issues.yml` | `schedule` (daily), `workflow_dispatch` | Closes open `agent` issues that have had no activity for 30 days by default | None |
| `agent-daily-summary.yml` | `schedule` (daily), `workflow_dispatch` | Generates a concise repository activity summary and posts it as a Discussion | Auto |
| `agent-project-manager.yml` | `schedule` (every 6h), `workflow_dispatch` | Opt-in agent-driven triage for open issues and PRs, with dry-run summaries and optional priority/effort label updates | Auto |
| `agent-onboarding.yml` | `workflow_dispatch` | First-run setup check that creates built-in trigger labels and opens or updates a setup issue | None |
| `test-scripts.yml` | `pull_request`, `workflow_dispatch` | CI for helper tests, YAML parsing, and shell syntax | None |

`agent-orchestrator.yml` is started explicitly through `/orchestrate` or
`agent/orchestrate`. On start, it inspects the current target state and
dispatches one built-in action (`implement`, `review`, or `fix-pr`) when useful.
That dispatch includes explicit orchestration context; only those orchestrator
launched action runs hand back to `agent-orchestrator.yml` after post-processing.
Direct `/implement`, `/review`, and `/fix-pr` runs remain one-shot.
When `AGENT_ALLOW_SELF_APPROVE=true`, orchestrated review runs that ship may
dispatch `agent-self-approve.yml` as a final pull request approval gate. That
route re-inspects the PR at a captured head SHA, reads memory and rubrics
read-only with read-approved tools, and submits an approving PR review only when
its structured verdict is `APPROVE`, a latest trusted review/rubrics signal
allows approval, and the inspected/current head SHA did not change. If it
returns `REQUEST_CHANGES`, the orchestrator may hand back to `fix-pr` with the
supplied context. With the
default `AGENT_ALLOW_SELF_APPROVE=false`, the route is not dispatched and review
`SHIP` still stops.
Explicit `/orchestrate` starts on pull requests are deterministic in both
`heuristics` and `agent` modes. Issue-level `/orchestrate` starts in `agent`
mode may use the planner. For small self-contained issue work, the planner can
return a normal handoff to `implement` on the current issue. For
meta-orchestration, the planner can return an internal `delegate_issue` command
instead of adding a new public route. That command creates or reuses a child
issue with parent/stage metadata, dispatches the child issue through the normal
`/orchestrate` flow in heuristic mode, and keeps the parent/child relationship
in GitHub issue state rather than session identity. When `delegate_issue` names
an existing user-authored issue, the orchestrator adopts it by writing the
trusted child marker in an agent-authored issue comment and recording the
parent/child link on the parent issue. The dispatcher also best-effort adds the
child as a GitHub sub-issue of the parent when the repository supports that REST
API; trusted markers remain the fallback relation if the API is unavailable.

Planner-based selection is also used for action-originated handoff runs. The planner can include a
`handoff_context` string for the next action; `fix-pr` receives it as explicit
initial steering when the planner dispatches a PR-fix pass. The planner mounts
memory and rubrics read-only so automated control-flow planning can use steering
context without mutating those state branches. Orchestration stops when target
state indicates no safe next action, a route fails, a duplicate handoff marker
is found, the planner stops or blocks, or the max-round budget is exhausted.

When a child issue reaches a terminal stop, the handoff dispatcher resolves the
trusted child metadata from the issue body or an agent-authored child issue
comment, or from the pull request body's closing issue reference when the
terminal target is a PR. It then posts or updates a visible progress comment on
the parent issue, dispatches the parent issue orchestrator again in agent mode,
and only then marks the trusted child marker as `done`, `blocked`, or `failed`.
Already-dispatched terminal reports are idempotent so reruns do not overwrite
completed child state.

Because `/orchestrate` can delegate into implementation, review, and fix
workflows, initial user-launched orchestrate requests validate the requester
against the delegated route capability set up front. Internal child and parent
resume dispatches carry `requested_by` for audit and display, but they do not
thread route authorization inputs through every child workflow.

Implementation dispatches default to the repository default branch. Callers can
set `base_branch` to stack directly on another branch, or `base_pr` to stack on
an open same-repository PR head branch. The implementation workflow rejects
ambiguous input when both are set.

When a new review synthesis, rubrics review, `fix-pr` status comment, or
orchestrator handoff marker is posted, the workflows minimize prior visible
matching comments and reviews from the same authenticated agent account as
outdated. Generated review summaries and `fix-pr` status comments carry hidden
HTML markers for robust matching, with heading/text fallbacks for older
comments. Rubrics reviews match the `## Rubrics Review` heading, and
orchestrator handoffs match their hidden handoff marker. This keeps the latest
generated status prominent while leaving older generated comments expandable.
Set `AGENT_COLLAPSE_OLD_REVIEWS=false` to skip this cleanup and leave prior
generated comments visible.

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
their guardrails in place. Before deleting a merged agent branch,
`agent-branch-cleanup.yml` retargets open PRs based on that branch to the
merged PR's base branch; if a retarget fails, the branch is left in place.

`agent-project-manager.yml` is disabled by default. Enable scheduled runs with
`AGENT_PROJECT_MANAGEMENT_ENABLED=true`, or run it manually with the `enabled`
input. It launches a prompt-driven, read-approved agent to inspect open issues
and pull requests, assess priority/effort with judgment rather than fixed
heuristics, and return a GitHub-flavored summary plus a structured managed-label
change plan. A deterministic post-agent CLI validates that plan and applies only
managed `priority/*` and `effort/*` add/remove operations when label application
is enabled and dry-run mode is disabled. Label application defaults enabled, but
dry-run mode defaults enabled too, so scheduled runs still report planned
changes without mutating labels until dry-run is disabled. The schedule runs
every 6 hours at minute 17 UTC. A
final workflow step writes the resulting summary to the Actions step summary.
Optional summary comments require `post_summary=true`; when enabled, that final
step finds today's `Daily Summary — YYYY-MM-DD` discussion in the configured
discussion category and comments there. If that discussion does not exist yet,
it leaves only the Actions step summary.

`agent-daily-summary.yml` checks repository discussion settings before gathering
activity signals or resolving an agent provider. If discussions are disabled, or
the configured summary discussion category does not exist, the workflow skips
signal collection and summary generation instead of spending runtime only to
fail while posting.

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
- `@sepo-agent /orchestrate`
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
- `agent/orchestrate`
- `agent/s/<skill>`

Run `Agent / Onboarding / Check Setup` after installing Sepo to create the
built-in labels. The workflow also opens or updates a `Sepo setup check` issue
with auth/provider readiness, memory and rubrics branch status, and copyable
commands for first test runs. Skill labels still use `agent/s/<skill>` and are
created per skill as needed.

After a label-triggered request is accepted by the router, `agent-label.yml` removes the triggering `agent/*` label so label-based runs behave like one-shot queue entries, including policy-denied requests that resolve to `unsupported`.

Built-in labels map directly to the existing routes. `agent/s/<skill>` runs `.skills/<skill>/SKILL.md` inline; if the skill file is missing, the runner posts a visible fallback comment instead of silently skipping the label.

If `AGENT_STATUS_LABEL_ENABLED=true`, accepted non-unsupported issue and pull request requests also get the fixed `agent` status label. This status label is separate from the `agent/*` trigger labels and does not select a route.

Label triggers authorize the label applier rather than the issue or pull request author. Personal-repository owners map to `OWNER`; visible organization members map to `MEMBER`; repository collaborators with label permission map to `COLLABORATOR`.

Skill names are normalized to lowercase, so `agent/s/Release-Notes` resolves to `.skills/release-notes/SKILL.md`. Skill directories should use lowercase names to match consistently across case-sensitive filesystems.

### `agent-approve.yml`

Approval comments on issues or discussions are matched by `@sepo-agent /approve <request_id>`. The workflow finds the unresolved request marker, creates an issue when required, and dispatches the encoded workflow.

The pending request data lives in a `<!-- sepo-agent-request ... -->` marker. Approval comments are checked against `AGENT_ACCESS_POLICY` using the route stored in that marker. For `implement` routes from non-issue surfaces, approval creates the issue from the marker's `issue_title` and `issue_body` before dispatching.
