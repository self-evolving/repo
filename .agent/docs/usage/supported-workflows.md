---
title: "Supported workflows"
---

## Workflow reference

### Core workflows

| Workflow | Trigger | Purpose | Model |
|---|---|---|---|
| `agent-label.yml` | `issues.labeled`, `pull_request_target.labeled` | Thin entry point for label-based activation into `agent-router.yml` | None |
| `agent-entrypoint.yml` | `@sepo-agent` in issues, PRs, discussions, comments, reviews | Thin entry point that wires triggers, runner labels, and secrets into `agent-router.yml` | None |
| `agent-router.yml` | `workflow_call` | Full portal for context extraction, auth gating, mention detection, dispatch triage, routing, approval requests, and response posting | Configurable |
| `agent-approve.yml` | approval comments | Resolves pending approvals, creates issues when needed, dispatches implementation | None |
| `agent-orchestrator.yml` | `workflow_dispatch` | Explicit orchestration route that decides whether to dispatch the next action | None in `heuristics` mode; resolved-provider planner in `agent` mode |
| `agent-self-approve.yml` | `workflow_dispatch` | Opt-in pull request self-approval gate after trusted current-head review synthesis | Auto |
| `agent-self-merge.yml` | `workflow_dispatch` | Opt-in deterministic merge gate after current-head Sepo self-approval | None |
| `agent-implement.yml` | `workflow_dispatch` | Implementation flow: branch, commit, draft PR; supports `base_branch` or `base_pr` for stacked PRs | Auto |
| `agent-fix-pr.yml` | `workflow_dispatch`, `workflow_call` | PR fix flow: update existing PR branch, verify, push | Auto |
| `agent-review.yml` | `workflow_dispatch`, `workflow_call` | Parallel Claude and Codex review with resolved-provider synthesis, captured reviewed-head provenance, plus a separate rubric review comment | Claude + Codex reviewers; configurable synthesis |
| `agent-branch-cleanup.yml` | `pull_request_target.closed` | Event-driven cleanup of merged agent-created branches after retargeting open stacked PRs. Excludes the shared `agent/memory` and `agent/rubrics` branches. | None |
| `agent-close-stale-issues.yml` | `schedule` (daily), `workflow_dispatch` | Closes open `agent` issues that have had no activity for 30 days by default | None |
| `agent-daily-summary.yml` | `schedule` (daily, disabled by default), `workflow_dispatch` | Generates a concise repository activity summary and posts it as a Discussion | Auto |
| `agent-project-manager.yml` | `schedule` (every 6h), `workflow_dispatch` | Opt-in agent-driven triage for open issues and PRs, with dry-run summaries and optional priority/effort label updates | Auto |
| `agent-update.yml` | `schedule` (1st and 15th), `workflow_dispatch` | Checks for Sepo agent infrastructure updates and opens a PR only when updates are available | Auto |
| `agent-onboarding.yml` | `workflow_dispatch` | First-run setup check that creates built-in labels and opens or updates an agent-tracked setup issue | None |
| `test-scripts.yml` | `pull_request`, `workflow_dispatch` | CI for helper tests, YAML parsing, and shell syntax | None |

All packaged `agent-*.yml` workflow jobs honor `AGENT_ENABLED=false` as a
global Sepo pause before checkout, auth, provider resolution, or runtime setup.
Unset `AGENT_ENABLED` or any value other than exact `false` leaves Sepo enabled.
`test-scripts.yml` remains normal CI and is not paused by this flag.

`agent-orchestrator.yml` is started explicitly through `/orchestrate` or
`agent/orchestrate`. Dispatch triage can also select `orchestrate` for issue and
pull request requests that ask for orchestration, follow-up automation, or
bounded multi-step agent work. On start, it inspects the current target state and
dispatches one built-in action (`implement`, `review`, `fix-pr`,
`agent-self-approve`, or `agent-self-merge`) when useful.
That dispatch includes explicit orchestration context; only those orchestrator
launched action runs hand back to `agent-orchestrator.yml` after post-processing.
Direct `/implement`, `/review`, and `/fix-pr` runs remain one-shot. Pull request
orchestrate starts remain deterministic in `heuristics` mode. In `agent` mode,
issue-level and pull-request-level orchestrate starts may use the planner. For
small self-contained issue work, the planner can return a normal handoff to
`implement` on the current issue. For PR work, the planner can choose
review-first, fix-the-PR, answer-only, or stop behavior; runtime policy validates
that PR starts dispatch only `review` or `fix-pr` workflows. For
meta-orchestration, the planner can return an internal `delegate_issue` command
instead of adding a new public route. That command creates or reuses a child
issue with parent/stage metadata, dispatches the child issue through the normal
`/orchestrate` flow in heuristic mode, and keeps the parent/child relationship
in GitHub issue state rather than session identity.
When `delegate_issue` names an existing user-authored issue, the orchestrator
adopts it by writing the trusted child marker in an agent-authored issue comment
and recording the parent/child link on the parent issue. The dispatcher also
best-effort adds the child as a GitHub sub-issue of the parent when the
repository supports that REST API; trusted markers remain the fallback relation
if the API is unavailable.

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

Because `/orchestrate` can delegate into implementation, review, fix, enabled
self-approval workflows, and enabled self-merge workflows, initial
user-launched orchestrate requests validate the requester against the delegated
route capability set up front. `agent-self-approve` is included in that check
only when `AGENT_ALLOW_SELF_APPROVE=true`; `agent-self-merge` is included only
when both `AGENT_ALLOW_SELF_APPROVE=true` and `AGENT_ALLOW_SELF_MERGE=true`.
Internal child and parent resume dispatches carry `requested_by` for audit and
display, but they do not thread route authorization inputs through every child
workflow.

Implementation dispatches default to the repository default branch. Callers can
set `base_branch` to stack directly on another branch, or `base_pr` to stack on
an open same-repository PR head branch. The implementation workflow rejects
ambiguous input when both are set.

The `add-rubrics` route reuses `agent-implement.yml` with
`base_branch=agent/rubrics` and `.github/prompts/agent-add-rubrics.md`. For that
route, Sepo keeps the default-branch runtime checkout in the main workspace and
runs the agent in a separate rubrics worktree so the proposal PR can target the
data-only `agent/rubrics` branch.

For explicit `/implement` requests from pull requests, the router's
metadata-only prompt may emit `base_pr` when the current user request asks for a
stacked or follow-up PR. The portal validates that value as a positive integer
and passes it through to `agent-implement.yml`; the implementation workflow then
verifies the PR is open and same-repository before using its head branch. If
the inferred source PR is closed or merged, the router omits `base_pr` before
dispatch and leaves the closed PR link in the tracking issue context so the run
starts from the default branch.

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

Review runs also attempt to capture the pull request head before reviewer lanes
start. The synthesis comment includes a hidden reviewed-head marker only if the
pull request still points at that same head before posting. If capture,
comparison, or prepare metadata setup cannot read PR metadata, synthesis still
posts without the hidden marker.

Review synthesis can also make prompt-managed inline review comment updates:
it may post a new inline comment, reply to an existing same-agent inline
comment, or clean up older same-agent inline feedback by synthesis-agent
judgment. Synthesis re-fetches PR inline comments and review threads before
cleanup. It resolves an older same-agent review thread only when the thread
belongs to the PR, is unresolved, `viewerCanResolve` is true, every thread
comment is from the same authenticated agent account, and the issue is
addressed or superseded. It marks an older same-agent inline comment as
outdated only when the comment is superseded and there is no appropriate
resolvable review-thread path. When authorship, PR ownership, supersession, or
resolution confidence is uncertain, synthesis does nothing. Reviewer lanes only
suggest these actions; they do not mutate GitHub. This inline behavior is
separate from the deterministic generated-comment cleanup controlled by
`AGENT_COLLAPSE_OLD_REVIEWS`.

### Repository memory workflows

| Workflow | Actions name | Trigger | Purpose | Model |
|---|---|---|---|---|
| `agent-memory-bootstrap.yml` | `Agent / Memory / Initialization` | `workflow_dispatch` | Seed the `agent/memory` branch on first run, then perform the initial sync and scan inline | Auto |
| `agent-memory-sync.yml` | `Agent / Memory / Sync GitHub Artifacts` | `schedule` (every 6h), `workflow_dispatch` | Deterministic mirror of issues, PRs, and discussions into the `agent/memory` branch | None |
| `agent-memory-pr-closed.yml` | `Agent / Memory / Record PR Closure` | `pull_request_target.closed`, `workflow_dispatch` | Agent-driven memory curation run triggered when a PR closes. Skips unmerged fork PRs. | Auto |
| `agent-memory-scan.yml` | `Agent / Memory / Curate Recent Activity` | `schedule` (every 6h), `workflow_dispatch` | Scheduled agent-driven memory curation across recent repository activity | Auto |

The `agent-memory-*` workflows and the `agent/memory` branch they share are documented in [Repository memory](../architecture/memory.md), including the layout, the `AGENT_MEMORY_POLICY` configuration, and per-route permission rules.

### User/team rubrics workflows

| Workflow | Actions name | Trigger | Purpose | Model |
|---|---|---|---|---|
| `agent-rubrics-initialization.yml` | `Agent / Rubrics / Initialization` | `workflow_dispatch` | Creates `agent/rubrics`, seeds the layout, and optionally populates initial rubrics from supplied context or repository history | Auto |
| `agent-rubrics-review.yml` | `Agent / Rubrics / Review` | `workflow_dispatch`, `workflow_call` | Scores a PR against active rubrics selected from `agent/rubrics`; skips model work when there is nothing to score | Auto |
| `agent-rubrics-update.yml` | `Agent / Rubrics / Update` | merged `pull_request_target.closed`, `workflow_dispatch` | Learns durable user/team preferences from PR interactions and updates `agent/rubrics` | Auto |

Rubrics are documented in [User/team rubrics](../architecture/rubrics.md). They are separate from repository memory: memory is agent/project continuity, while rubrics are normative user/team preferences used to steer implementation and evaluate reviews.

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
fail while posting. Cron-triggered daily summaries are disabled by default;
manual `workflow_dispatch` remains available, and repositories can enable the
cron with an `AGENT_SCHEDULE_POLICY` workflow override.

`agent-update.yml` runs near-biweekly because GitHub cron does not support a
native every-14-days cadence. It resolves its source to the latest published
stable Sepo release tag before invoking the dedicated `update-agent` route and
`.github/prompts/agent-update.md` prompt.
Manual dispatch can pass `source_ref` to test `main`, a branch, or a specific
tag. If no release exists yet, it falls back to `main` and records that fallback
in the run summary. The workflow skips when `AGENT_AUTO_UPDATE=false` or
`AGENT_SCHEDULE_POLICY` disables it. When a same-repository
`agent/update-agent-infra-*` PR is already open, the workflow keeps the runtime
checkout on the default branch, prepares the existing PR branch as the update
target, and asks the update route to update that PR instead of opening a
duplicate. A manual `force=true` run ignores the existing PR lookup and starts
from the default branch. The canonical `self-evolving/repo` source repository
should set `AGENT_AUTO_UPDATE=false` when scheduled self-updates are not wanted;
manual dispatch remains available for explicit source ref testing.

Single-agent routes, autonomous agent workflows, fixed review lanes, and the review synthesis step resolve provider/model settings before installing provider CLIs. Explicit provider choices from inline workflow `route_provider`, `AGENT_MODEL_POLICY.route_overrides[route].provider`, or `AGENT_DEFAULT_PROVIDER` are authoritative: the workflows select that provider even when the matching repository secret is absent, so self-hosted runners can rely on local Codex or Claude authentication. When the provider is `auto`, detection uses configured provider secrets and prefers Codex when `OPENAI_API_KEY` is configured; otherwise Claude is selected when either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is present. Resolved Codex and Claude runs use Sepo's small pinned model defaults unless `AGENT_MODEL_POLICY` overrides them: `gpt-5.5` for Codex and `claude-opus-4-8` for Claude. `AGENT_MODEL_POLICY` can also set provider-specific models and route-specific model or reasoning effort overrides; inline workflow `route_provider` remains the native escape hatch. Portal and skill jobs use non-fatal early resolution before non-agent response paths, then require a provider only immediately before invoking an agent. The review workflow's Claude/Codex reviewer lanes keep fixed providers through inline `route_provider`, so provider-specific model settings apply there while route-specific review overrides are left to synthesis.

### GitHub attachment downloads

Agent prompts include an on-demand command for private GitHub attachment links:

```shell
node .agent/dist/cli/download-github-attachment.js --url "<attachment-url>"
```

The command is attachment-specific. It accepts only `https://github.com/user-attachments/files/...` and `https://github.com/user-attachments/assets/...` URLs, downloads with the normal agent GitHub token from `INPUT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`, and writes files under `$RUNNER_TEMP/agent-attachments`. It rejects other GitHub URLs and non-GitHub URLs so the command does not become a general authenticated fetch primitive. Downloads use safe filenames, a 30 second timeout, and a 25 MiB default size cap. `GITHUB_ATTACHMENT_TIMEOUT_MS` and `GITHUB_ATTACHMENT_MAX_BYTES` may override those limits for a run. The command prints JSON metadata including the original URL, local path, filename, byte count, content type, and HTTP status.

## Trigger details

### `agent-entrypoint.yml`

The broad pre-filter starts the router when the event contains `@sepo-agent`. Real mention validation happens in `agent-router.yml` through `extract-context.js`. That validation is boundary-aware and strips code blocks and quoted text before deciding whether a mention is live.

When `AGENT_FOLLOWUP_INTENT_MODE` is unset or `agent-label`, new unmentioned issue/PR comments, new PR review comments, and submitted PR reviews can also wake the router if the target already has the fixed `agent` label. The router marks these as `implicit_followup=true`, checks `answer` route authorization before the intent gate, and only continues to the inline `answer` route when the communication-rubric-aware gate returns `respond`. `ignore` posts nothing. Set `AGENT_FOLLOWUP_INTENT_MODE=disabled` or `false` to require explicit mentions only.

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

By default, the portal responds to `OWNER`, `MEMBER`, `COLLABORATOR`, and `CONTRIBUTOR` associations. `AGENT_ACCESS_POLICY` can tighten or widen access globally or for specific routes; public repositories that do not want prior contributors to trigger Sepo should remove `CONTRIBUTOR` from the allowlist. Bot authors are always skipped. Mention-based implicit route requests are triaged first and then checked against the resolved route, so denied requests get a visible unsupported reply instead of being dropped silently. Unmentioned implicit follow-ups are answer-only and are dropped silently when the answer route is not authorized. See [Trigger access policy](../customization/access-policy.md).

Explicit routes are:

- `@sepo-agent /answer`
- `@sepo-agent /implement`
- `@sepo-agent /create-action`
- `@sepo-agent /fix-pr`
- `@sepo-agent /review`
- `@sepo-agent /orchestrate`
- `@sepo-agent /skill <name>`
- `@sepo-agent /install ...`

Explicit routes skip dispatch triage and resolve locally, but still go through the same route policy checks afterward.
When an explicit `/implement` request on a pull request or discussion creates a tracking issue, the router runs a metadata-only agent prompt to synthesize the issue title and body from the request plus target context. The slash command approves the route; it is not copied into the title. Pull request metadata can also include `base_pr` for stacked or follow-up implementation requests. If metadata generation is unavailable or invalid, the issue falls back to `Implement requested change`.

Mention-based skill requests normalize the skill name to lowercase and run
`<skill_root>/<name>/SKILL.md` inline through the same `skill` route used by
`agent/s/<skill>` labels. If `<skill_root>/<name>/setup.sh` exists, the skill
job runs it from the repository root before the agent task starts. More complex
skill setup should customize the copied `agent-router.yml` skill job directly
so repositories can use native GitHub Actions `uses`, `with`, Docker, service,
or cache features.

`/install` is a first-class route that passes the full request to the dedicated
`agent-install` prompt. Install-specific helper code resolves the target from an
`owner/repo` slug, a GitHub URL, or a clear natural-language repository
reference, and blocks for clarification when the target is missing or ambiguous.
Access policy evaluates it as the `install` route, so
`AGENT_ACCESS_POLICY.route_overrides.install` can restrict external installs
without blocking general `/skill` runs. The install route uses a dedicated
source-repo install credential; other routes continue using the standard GitHub
auth resolver. The prompt uses the install fork/PR helper to prepare a
fork-backed worktree, then push, reuse, or open the install PR. Source-repo
memory is disabled for install runs so that install credentials cannot write
`agent/memory`. Issue-backed install requests can
start from the install request issue form; when publish succeeds, the target PR
body links the source issue and the source issue is closed best-effort after the
install response is posted.

Non-install agent runs can also receive the optional
`AGENT_SECONDARY_GITHUB_TOKEN` secret as `INPUT_SECONDARY_GITHUB_TOKEN`. This
secondary credential is for explicit read-only external repository inspection
and does not replace the primary same-repository token, including the dedicated
`/install` primary token described above. External writes need a route-specific
credential and deterministic write authorization before a route exposes them to
the agent.

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
built-in labels. The workflow also ensures the non-trigger `agent` status label
exists, applies it to the `Sepo setup check` issue, and opens or updates that
issue with auth/provider readiness, memory and rubrics branch status, and
copyable commands for first test runs. The status label makes the setup issue
eligible for `Agent / Close Stale Issues` after the standard inactive window.
Skill labels still use `agent/s/<skill>` and are created per skill as needed.
Onboarding also creates the non-trigger `agent-goal` label used by the
[repository goals](../architecture/goals.md) convention.

After a label-triggered request is accepted by the router, `agent-label.yml` removes the triggering `agent/*` label so label-based runs behave like one-shot queue entries, including policy-denied requests that resolve to `unsupported`.

Built-in labels map directly to the existing routes. `agent/s/<skill>` runs
`<skill_root>/<skill>/SKILL.md` inline; if the skill file is missing, the runner
posts a visible fallback comment instead of silently skipping the label.

If `AGENT_STATUS_LABEL_ENABLED=true`, accepted non-unsupported issue and pull request requests also get the fixed `agent` status label. This status label is separate from the `agent/*` trigger labels and does not select a route.

Label triggers authorize the label applier rather than the issue or pull request author. Personal-repository owners map to `OWNER`; visible organization members map to `MEMBER`; repository collaborators with label permission map to `COLLABORATOR`.

Skill names are normalized to lowercase, so `agent/s/Release-Notes` resolves to
`.skills/release-notes/SKILL.md` by default. Skill directories should use
lowercase names to match consistently across case-sensitive filesystems.

### `agent-self-approve.yml`

Self-approval is disabled unless `AGENT_ALLOW_SELF_APPROVE=true`. The manual
workflow accepts a pull request number, confirms the target is an open PR, and
requires latest trusted review synthesis from the authenticated Sepo actor for
the current reviewed-head marker before it runs an approval agent. Normal runs
require that synthesis to be `SHIP`; orchestrated review `HUMAN_DECISION`
handoffs may also run the agent as a decision gate for non-`SHIP` verdicts. The
agent runs with `approve-all` ACPX tool permissions so it can perform required
read-only `gh` and `git` PR investigation commands. The workflow still passes a
read-scoped `github.token` to the agent, and the agent returns structured JSON
with a verdict, reason, optional follow-up context, and `inspected_head_sha`.

Deterministic resolver code is the only part that can submit or record the
approval. It rereads the current PR head, rechecks trusted current-head review
provenance, verifies the approval actor differs from the pull request author
unless both `AGENT_ALLOW_SELF_APPROVE=true` and `AGENT_ALLOW_SELF_MERGE=true`
are enabled, parses the agent verdict, and approves only when the expected,
current, and inspected head SHAs match. Normal handoffs require trusted
current-head `SHIP` review synthesis; orchestrated review `HUMAN_DECISION`
handoffs also trust the matching current-head synthesis as the decision gate.
Non-approval outcomes post a compact PR status comment. In full
self-governance mode, same-actor approvals are recorded as a current-head
self-approval status comment rather than a GitHub review approval. In
orchestrated chains, `SHIP` review synthesis and review syntheses that recommend
`HUMAN_DECISION` can hand off to `agent-self-approve`; non-`SHIP`
`HUMAN_DECISION` runs let self-approval approve, request changes, or block. A
self-approval `REQUEST_CHANGES` result can hand off to `fix-pr` with the
approval agent's handoff context. Self-approval status comments are upserted by
marker against comments authored by the authenticated Sepo actor, and result
artifacts are retained for failed or blocked resolution paths where available.

### `agent-self-merge.yml`

Self-merge is disabled unless `AGENT_ALLOW_SELF_MERGE=true`. The workflow is
deterministic: it reads the current PR metadata, requires a trusted Sepo
self-approval review or self-approval status comment for the current head SHA,
blocks requested-changes and failed-check states, marks draft PRs ready, then
merges into the PR's configured base when GitHub reports it mergeable. If checks
are still pending and GitHub reports an eligible merge state, it enables GitHub
auto-merge instead.

The final merge and auto-merge commands use `--match-head-commit` with the
approved head SHA, so a push after preflight cannot merge an unapproved head.
Self-merge status comments are marker-upserted against comments authored by the
authenticated Sepo actor. In orchestrated chains, an `agent-self-approve`
`APPROVED` result can hand off to `agent-self-merge` only when self-merge is
also enabled.

### `agent-approve.yml`

Approval comments on issues or discussions are matched by `@sepo-agent /approve <request_id>`. The workflow finds the unresolved request marker, creates an issue when required, and dispatches the encoded workflow.

The pending request data lives in a `<!-- sepo-agent-request ... -->` marker. Approval comments are checked against `AGENT_ACCESS_POLICY` using the route stored in that marker. For `implement` routes from non-issue surfaces, approval creates the issue from the marker's `issue_title` and `issue_body` before dispatching.
