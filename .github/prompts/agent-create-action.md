## Task Description

The user asked the agent to create a recurring or durable automation.

Your task is to open a normal implementation PR that adds or updates one native GitHub Actions workflow under `.github/workflows/`. Do **not** create `.agent/actions/*` specs, a generic scheduler, or new runtime infrastructure.

## Scheduled Workflow Contract

Use GitHub Actions as the scheduler and activation mechanism:

- Start from `.agent/action-templates/agent-action-template.yml`, copy it to `.github/workflows/agent-action-<short-slug>.yml`, and replace every placeholder.
- Include `workflow_dispatch` for manual test runs.
- Include `schedule` only when the requested automation should run automatically.
- Use the existing shared actions from the template: `resolve-github-auth`, `resolve-agent-provider`, `check-agent-action-expiration`, `setup-agent-runtime`, and `run-agent-task`.
- Keep the workflow scoped with least-privilege GitHub permissions; add issue write permission only when enabling issue reporting.
- Set a unique `lane` such as `agent-action-<short-slug>` so scheduled runs do not share session identity with normal answer traffic.
- Set `permission_mode: approve-all`, `memory_mode_override: read-only`, and `session_policy: track-only` for the scheduled agent task so recurring runs do not write repository memory or try to resume interactive sessions.
- Prefer `prompt: answer` and `route: answer`; put the bounded recurring task in `request_text`.
- If the workflow should report to an issue, set `REPORT_ISSUE_NUMBER`, add `issues: write`, and post `steps.agent.outputs.response_file` to that issue after the agent run.

## Expiration Guard

GitHub Actions does not expire scheduled workflows automatically. Every generated scheduled workflow must use the shared expiration action before provider/runtime setup and before the agent run:

```yaml
- name: Check expiration
  id: expiration
  uses: ./.github/actions/check-agent-action-expiration
  with:
    expires_at: ${{ env.ACTION_EXPIRES_AT }}
```

Gate all expensive/provider-backed steps with:

```yaml
if: steps.expiration.outputs.expired != 'true'
```

Use a simple static expiration date unless the user specifies one. If unspecified, choose a short default such as 30 days from the current date and mention it in the PR body.

Do not add automatic extension or cleanup logic in the first generated workflow unless the user explicitly asked for lifecycle automation. Extending or removing an expired workflow should happen through normal PR review.

## Instructions

1. Read the issue and linked context with `gh`.
2. Inspect `.github/workflows/` for an existing generated workflow that should be updated instead of adding a duplicate.
3. Copy `.agent/action-templates/agent-action-template.yml` to the generated workflow path and fill in the workflow name, cron, expiration, lane, request text, and optional reporting target. Add `issues: write` only when setting `REPORT_ISSUE_NUMBER` for issue reporting.
4. Add or update exactly one standalone workflow unless the request clearly requires more.
5. Keep the recurring task bounded: describe what to check, allowed side effects, expiration, and where to report.
6. Do not add custom scheduler code, `.agent/actions` specs, or a new `run-action` route.
7. Run focused validation, at minimum YAML parsing for the generated workflow and `cd .agent && npm test` when practical.

## Response Format

Return exactly one JSON object:

```json
{
  "summary": "What scheduled workflow was added or changed, how it is triggered, and when it expires.",
  "commit_message": "Add scheduled agent workflow",
  "pr_title": "Add scheduled agent workflow",
  "pr_body": "Summary, trigger schedule, expiration date, reporting behavior, validation, and issue-closing text when applicable."
}
```
