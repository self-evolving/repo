---
title: "The life cycle of an agent request"
---

## Entry and routing

Every trigger converges on the portal workflow `agent-router.yml`. It extracts context, validates mentions, records the caller association, optionally runs dispatch triage, applies route authorization, and routes the request to a specialized workflow or inline answer path.

Explicit mentions remain the primary trigger. When `AGENT_FOLLOWUP_INTENT_MODE` is `agent-label` (the default), new unmentioned issue/PR comments, new PR review comments, and submitted PR reviews on targets with the fixed `agent` label can also enter the portal as `implicit_followup=true`. The portal checks `answer` route authorization before running the dedicated intent gate with the same communication-rubric selection used by answer runs. The gate can only return `respond` or `ignore`; `respond` is forced to the inline `answer` route, while `ignore` posts nothing.

## Approval model

- Inline answers are posted immediately.
- Implicit follow-up answers are posted only after the intent gate returns `respond`; they never dispatch implementation, review, PR-fix, orchestration, install, skill, or create-action workflows.
- Review and `fix-pr` requests on pull requests are dispatched immediately.
- Explicit `/orchestrate` (or `agent/orchestrate`) requests dispatch the orchestrator workflow, which chooses one follow-up action from current target state.
- Edited PR events are blocked from re-triggering review and `fix-pr` routes.
- Mention and label requests that fail route authorization are posted back as inline `unsupported` replies instead of being dropped silently; that path still runs `Setup agent runtime` before `post-response.js` so posting dependencies are available.
- Triaged implementation requests (i.e., when the dispatch agent predicts `implement` from a free-form mention) require an approval comment:
  - `@sepo-agent /approve req-...`
- For triaged implementation requests from non-issue surfaces, the router drafts an issue title and body, posts the proposal on the original surface, and creates the issue after approval.
- Explicit implementation requests (`@sepo-agent /implement ...` or the `agent/implement` label) skip the approval comment. The router creates a tracking issue if the surface isn't already an issue and dispatches `agent-implement.yml` directly, since the explicit mention is itself the approval. For pull request and discussion surfaces, the router asks a metadata-only agent prompt to synthesize the tracking issue title and body from the request and target context; for PR requests that explicitly ask for stacked or follow-up work, that metadata can also provide `base_pr` so the implementation PR stacks on the source PR head. If the inferred source PR is closed or merged, the router omits `base_pr`, adds a base-branch note to the tracking issue, and lets implementation start from the repository default branch while keeping the closed PR link as context. If that metadata is unavailable or invalid, it falls back to the generic implementation issue metadata. Access control (`AGENT_ACCESS_POLICY`) still applies to the `implement` route. The explicit path also passes a session-fork hint from the original target's `answer/default` thread, so implementation can continue from a prior answer session when that bundle exists.

PR fix requests never create a tracking issue or a new pull request. The runner updates the existing PR branch after reading PR metadata and review comments. Dirty worktree changes are committed and pushed back to the PR branch; clean history-only updates, such as a successful rebase, run verification against the original PR head and then push the updated `HEAD` back to the PR branch with a lease against that original head. If persistence fails after a successful agent run, the final status comment reports the run as failed. Automatic pushing is limited to open same-repository pull requests, and route access follows the configured trigger access policy.

## Branch naming

Agent workflows that create branches use:

```text
agent/<route>-<target_kind>-<number>/<agent>-<run_id>
```

For example:

```text
agent/implement-issue-42/codex-23948660610
```

The run ID makes each attempt unique to avoid push conflicts on retries. The branch name is set once at the job `env:` level and reused by all steps. Routes that work on existing branches, such as `fix-pr`, do not create new branches.

## Permission model

Current route-level `acpx` permission modes:

| Route | acpx mode | Rationale |
|---|---|---|
| `dispatch` | `approve-all` | classification may gather repo and issue context |
| `answer` | `approve-all` | may gather context before replying |
| `orchestrator` | `approve-all` | planner may gather target and repository context before choosing the next route |
| `agent-self-approve` | `approve-all` | final approval judgment may run the PR/repo inspection commands it needs, while deterministic resolver code owns approval submission or internal approval recording |
| `agent-self-merge` | none | deterministic workflow code owns current-head approval validation and merge submission |
| `implement` | `approve-all` | needs full file system access |
| `fix-pr` | `approve-all` | needs full file system access |
| `review` | `approve-all` | reviewers and synthesis may gather PR and repo context |

Dedicated memory and rubric maintenance workflows use the same runtime but are documented with their storage systems rather than the user-request lifecycle. Workflow-level GitHub token scopes are set by each workflow or job and remain separate from route-level `acpx` modes. The self-approval workflow uses `approve-all` so the inspection agent can run required read-only `gh` and `git` investigation commands, but it still passes the read-scoped `github.token` to that agent; deterministic resolver code uses the resolved Sepo auth token for approval submission or for marker-upserted internal approval status when full self-governance mode is enabled. Self-merge has no model step; its deterministic resolver uses the resolved Sepo auth token only after current-head self-approval, checks, mergeability, and requested-change guards pass.
