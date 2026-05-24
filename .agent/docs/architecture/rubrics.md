---
title: "User/team rubrics"
---

Rubrics are a separate durable system from repository memory.

- `agent/memory` stores agent/project continuity: what the agent learns about the repository, prior work, and its own operating context.
- `agent/rubrics` stores user/team preferences: what users want future agent work to optimize for and what review should evaluate.

Rubrics are therefore normative, not merely contextual. Normal implementation and review runs read them, but only dedicated rubrics workflows should write them.

## Branch layout

Rubrics live on a dedicated branch, `agent/rubrics` by default. The branch is mounted into runs as `$RUBRICS_DIR`.

Seeded layout:

| Path | Purpose |
|---|---|
| `README.md` | Describes the rubrics branch and its distinction from memory |
| `rubrics/coding/*.yaml` | Coding style / coding workflow rubrics |
| `rubrics/communication/*.yaml` | Communication rubrics |
| `rubrics/workflow/*.yaml` | Development workflow rubrics |

Each rubric is one YAML file. Subdirectories are organizational; the schema fields remain the source of truth.

## Schema

```yaml
schema_version: 1
id: add-regression-tests
title: Add regression tests for bug fixes
description: >-
  When fixing a bug, include a regression test that fails before the fix
  and passes after it.
type: generic # generic | specific
domain: coding_workflow # coding_style | coding_workflow | communication | review_quality
applies_to:
  - implement # implement | add-rubrics | fix-pr | review | agent-self-approve | agent-self-merge | answer | skill | rubrics-review | rubrics-initialization | rubrics-update
severity: should # must | should | consider
weight: 3 # 1-10
status: active # active | draft | retired
examples:
  - source: https://github.com/self-evolving/repo/pull/96
    note: Reviewer asked for stronger validation and tests around workflow behavior.
```

Required fields are `id`, `title`, `description`, and `applies_to`. Missing optional fields default as follows:

| Field | Default |
|---|---|
| `schema_version` | `1` |
| `type` | `generic` |
| `domain` | `coding_workflow` |
| `severity` | `should` |
| `weight` | `1` |
| `status` | `active` |
| `examples` | `[]` |

The legacy `category: coding` field is accepted as a fallback for `domain` during migration, but new rubrics should use `domain`.

## Runtime use

`run-agent-task` resolves rubric access with `AGENT_RUBRICS_POLICY`, downloads the rubrics branch when enabled, selects route-applicable rubrics, and prepends `.github/prompts/_rubrics.md` to the route prompt.

Dispatch triage is always rubric-disabled. Rubrics should steer concrete work and review, not route selection.

Selection is intentionally simple and acts as prompt-time retrieval guidance:

1. Load `rubrics/**/*.yaml`.
2. Validate schema and unique IDs.
3. Keep active rubrics whose `applies_to` includes the current route. `implement` rubrics also apply to `fix-pr` as baseline implementation guidance; `install` is its own route for install-specific rubrics.
4. For answer runs, keep only communication-domain rubrics so answer behavior is steered by communication preferences.
5. Rank by severity, weight, and token matches against request text.
6. Inject the top N rubrics into the prompt through `${RUBRICS_CONTEXT}` as a starting shortlist.

The prompt also tells agents that `$RUBRICS_DIR` is browseable. Agents can inspect the checkout for additional active user/team rubrics when the selected shortlist is incomplete for implementation, PR fixes, reviews, or answers.

Read-only selection is best-effort: invalid rubric files are emitted as workflow warnings and valid rubrics still steer the agent. The write path remains strict; dedicated rubrics workflows validate the full checkout before committing.

## Workflows

| Workflow | Trigger | Purpose | Writes `agent/rubrics`? |
|---|---|---|---|
| `agent-rubrics-initialization.yml` (`Agent / Rubrics / Initialization`) | `workflow_dispatch` | Creates `agent/rubrics`, seeds the branch layout, and asks an agent to populate initial rubrics from supplied context or repository history | Yes |
| `agent-add-rubrics.yml` (`Agent / Rubrics / Add`) | rubric requests, explicit `/add-rubrics`, `agent/add-rubrics`, `workflow_dispatch` | Adds or updates rubric YAML from a trusted request, opening a proposal PR by default or committing directly when explicitly requested, and posts a summary | Direct mode only |
| `agent-rubrics-review.yml` (`Agent / Rubrics / Review`) | `workflow_dispatch`, `workflow_call` | Scores a PR against selected active rubrics and uploads or posts a review artifact | No |
| `agent-rubrics-update.yml` (`Agent / Rubrics / Update`) | merged `pull_request_target.closed` with review interaction, `workflow_dispatch` | Distills durable user/team preferences from merged PR conversations | Yes |

`agent-review.yml` calls `Agent / Rubrics / Review` as an independent review lane that posts its own PR comment. Core review synthesis does not depend on rubrics review, so rubric scoring failures do not block the normal review comment.

`Agent / Rubrics / Initialization` is the recommended first-run setup path. It rejects existing rubrics branches, bootstraps the branch skeleton, then runs an initialization prompt. Operators can provide arbitrary context, such as desired team preferences or links to important PRs/issues. When context is omitted, the agent inspects recent merged PRs and trusted contributor feedback to seed only durable rubrics. Initialization fails if the workflow cannot commit and push the new rubrics branch.

`Agent / Rubrics / Add` is the user-facing add-or-update path for conversation requests. Dispatch triage sends natural rubric requests to this route and resolves `rubrics_write_mode`: the default `proposal_pr` checks out `agent/rubrics`, commits validated edits to an `agent/rubrics-proposal-*` branch, and opens a PR targeting `agent/rubrics`; explicit phrases such as "just add", "commit directly", or "apply now" select `direct_commit`, which writes validated edits straight to `agent/rubrics`. Both modes read existing rubrics first, prefer updating active rubrics over creating near-duplicates, validate the full checkout before persisting, serialize writes against the rubrics branch, and post a summary even when the run or persistence step fails.

`Agent / Rubrics / Update` posts a short PR summary after each completed learning run. The summary says whether `agent/rubrics` was committed and includes the agent's explanation, including `no rubric changes` decisions, so skipped learning is visible without opening Actions logs.

Rubric learning remains conservative about trust. Owner/admin/maintain comments are primary signals, and `OWNER`, `MEMBER`, and `COLLABORATOR` author associations are trusted contributor signals for clear durable preferences. On automatic merged-PR update runs, the `requested_by` field is the close/merge actor; if that same actor authored an explicit request to add or update rubrics, the prompt treats that source as trusted even when best-effort GitHub App collaborator lookups are incomplete. That exception does not trust other PR participants.

## Access policy: `AGENT_RUBRICS_POLICY`

Rubrics policy mirrors memory policy but defaults to `read-only`, because rubrics are user/team preferences and should not be casually mutated by normal task runs.

```json
{
  "default_mode": "read-only",
  "route_overrides": {
    "add-rubrics": "enabled",
    "rubrics-update": "enabled",
    "answer": "disabled"
  }
}
```

Modes:

- `enabled` — mount rubrics and commit validated edits after a successful run
- `read-only` — mount rubrics and inject selected rubrics, but skip commits
- `disabled` — skip rubrics entirely

Dedicated rubric-initialization, add-rubrics, and rubric-update runs pass `rubrics_mode_override: enabled`, so they can write the branch even when the repository default is read-only. Only rubric initialization bootstraps a missing branch; add-rubrics and rubric update expect `agent/rubrics` to already exist.

Normal implementation, fix, review, and rubric-review callers do not pass a rubric mode override; they honor `AGENT_RUBRICS_POLICY` and default to read-only when no policy is configured.

## CLIs

| CLI | Purpose |
|---|---|
| `rubrics/init.js` | Seed a local rubrics checkout |
| `rubrics/validate.js` | Validate rubric YAML files and unique IDs |
| `rubrics/select.js` | Select and render applicable rubrics for a route |
| `rubrics/resolve-policy.js` | Resolve effective route mode |

Validation runs before committing rubric edits. Invalid YAML or duplicate IDs fail the write path rather than publishing broken rubrics.
