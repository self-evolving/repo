# Key concepts

## Self-evolving repository

The core idea is a GitHub-native agent system where the repository itself can:

- answer questions inline
- implement approved changes
- review pull requests
- apply fixes to pull requests
- accumulate continuity across repeated runs on the same thread

## GitHub-native agent sessions

- Mention the agent in a GitHub issue, PR, or discussion and it answers or does the work in place.
- Agent sessions run in GitHub Actions, with no separate chat tool or external session manager required.

## Self-evolution

- The agent can act through GitHub workflow triggers to assess repo state and improve code or automation.
- It can also improve the supporting agent infrastructure in the repository.

## Core runtime vocabulary

### Route

A route is the high-level backend behavior being run. Current first-class routes are:

- `answer`
- `implement`
- `fix-pr`
- `review`
- `create-action`
- `dispatch`
- `skill`
- `rubrics-review`
- `rubrics-initialization`
- `rubrics-update`

Routes shape prompt selection, route policy, and which workflow path the backend follows. Dedicated rubric routes operate on user/team rubrics rather than general repository memory.

### Lane

A lane separates continuity identity for runs that share the same target but should not reuse the same session history. Review jobs are the clearest example: Claude review, Codex review, and synthesis all use different lanes.

### Thread key

A thread key is the durable identity used for persistent state:

```text
repo:target_kind:target_number:route:lane
```

This is what lets later runs find the right thread state and prior session records.

## Runtime metadata

### RuntimeEnvelope

Every agent run receives a shared metadata envelope.

| Field | Meaning |
|---|---|
| `schema_version` | Envelope version, currently `1` |
| `repo_slug` | Repository as `owner/repo` |
| `route` | agent action like `review`, `implement`, `fix-pr`, `answer`, `create-action`, `dispatch`, or `skill` |
| `source_kind` | Triggering surface, such as `issue_comment`, `pull_request_review`, or `workflow_dispatch` |
| `target_kind` | `issue`, `pull_request`, `discussion`, or `repository` |
| `target_number`, `target_url` | Canonical target identity. Repo-scoped runs reserve `target_number=0` and use the repository URL. |
| `request_text`, `requested_by` | User request and GitHub login |
| `approval_comment_url` | Approval comment URL, when present |
| `workflow` | Workflow file name passed by the workflow |
| `lane` | Session lane, defaults to `default` |
| `thread_key` | `repo:target_kind:target_number:route:lane` |

The envelope is defined in `.agent/src/envelope.ts`.

The `repository` target kind exists for repo-scoped workflows that are not anchored to a single issue, PR, or discussion. `agent-memory-scan.yml` is the current example: it still needs a stable thread identity, so it uses the same envelope shape with `target_kind=repository` and `target_number=0`.

## Prompt template variables

Each model prompt receives a shared set of rendered variables, including:

- `REPO_SLUG`
- `TARGET_KIND`
- `TARGET_NUMBER`
- `TARGET_URL`
- `SOURCE_KIND`
- `REQUEST_TEXT`

A shared base prompt from `.github/prompts/_base.md` is prepended to each route-specific template before placeholder substitution in `renderPrompt()` in `.agent/src/run.ts`. When `MEMORY_AVAILABLE == "true"`, the runtime also prepends `.github/prompts/_memory.md`; otherwise memory guidance is omitted entirely.

Some routes also expose an explicit allowlist of supplemental env-backed prompt variables such as `MEMORY_DIR`, `MEMORY_REF`, `REVIEWS_DIR`, and the PR-fix request comment fields. Adding a new prompt variable requires updating the allowlist in `.agent/src/run.ts`.

## Session continuity and forks

Persistent routes store thread state in git refs and can optionally restore local agent session files from GitHub Actions artifacts. A destination run may also be seeded from another thread via `session_fork_from_thread_key`; explicit `/implement` uses this to continue from the prior `answer/default` thread for the original target when available. See [Session continuity](session-continuity.md).

## Repository memory

The agent composes long-lived memory across runs on a dedicated `agent/memory` branch, governed by `AGENT_MEMORY_POLICY`. Memory is agent/project continuity: what the agent learns to improve its own future work and understand the repository. See [Repository memory](../architecture/memory.md) for layout, CLIs, access modes, and safety rules.

## User/team rubrics

Rubrics live on a separate `agent/rubrics` branch, governed by `AGENT_RUBRICS_POLICY`. Rubrics are normative user/team preferences: what users want the agent to optimize for during implementation and what review should score against. Normal implementation and review runs read rubrics; `Agent / Rubrics / Update` is the dedicated write path. See [User/team rubrics](../architecture/rubrics.md).

## Runtime dependencies

The reusable workflows bootstrap the runtime in place by checking out the repository, running `.github/actions/setup-agent-runtime`, installing dependencies inside `.agent/`, building `.agent/dist/`, and optionally installing `codex` or `claude`.

Remaining runner requirements:

- `git`, `gh`, `jq`, `curl`, `bash`, and network access
- one GitHub auth mode
- `id-token: write` for the official hosted auth path
- `OPENAI_API_KEY` for Codex-backed workflows
- optional `CLAUDE_CODE_OAUTH_TOKEN` for Claude-backed routes

## Tests

The backend has both TypeScript runtime tests and workflow-oriented helper tests.

```bash
cd .agent
npm ci
npm test
```
