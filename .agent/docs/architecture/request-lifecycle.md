# The life cycle of an agent request

## Entry and routing

Every trigger converges on the portal workflow `agent-router.yml`. It extracts context, validates mentions, records the caller association, optionally runs dispatch triage, applies route authorization, and routes the request to a specialized workflow or inline answer path.

## Approval model

- Inline answers are posted immediately.
- Review and `fix-pr` requests on pull requests are dispatched immediately.
- Edited PR events are blocked from re-triggering review and `fix-pr` routes.
- Mention and label requests that fail route authorization are posted back as inline `unsupported` replies instead of being dropped silently; that path still runs `Setup agent runtime` before `post-response.js` so posting dependencies are available.
- Triaged implementation requests (i.e., when the dispatch agent predicts `implement` from a free-form mention) require an approval comment:
  - `@sepo-agent /approve req-...`
- For triaged implementation requests from non-issue surfaces, the router drafts an issue title and body, posts the proposal on the original surface, and creates the issue after approval.
- Explicit implementation requests (`@sepo-agent /implement ...` or the `agent/implement` label) skip the approval comment. The router creates a tracking issue if the surface isn't already an issue and dispatches `agent-implement.yml` directly, since the explicit mention is itself the approval. Access control (`AGENT_ACCESS_POLICY`) still applies to the `implement` route. The explicit path also passes a session-fork hint from the original target's `answer/default` thread, so implementation can continue from a prior answer session when that bundle exists.

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
| `implement` | `approve-all` | needs full file system access |
| `fix-pr` | `approve-all` | needs full file system access |
| `review` | `approve-all` | reviewers and synthesis may gather PR and repo context |

Dedicated memory and rubric maintenance workflows use the same runtime but are documented with their storage systems rather than the user-request lifecycle. The workflow-level GitHub token still has write scope for all jobs. Narrowing that token per job is tracked separately. The `acpx` permission modes restrict agent tool use but not direct `gh` CLI calls.
