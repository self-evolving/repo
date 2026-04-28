# Creating your own actions

Durable agent actions are repository-owned GitHub Actions workflows. They let a
user ask the agent to propose recurring automation, review it as a pull request,
and activate it only after merge.

Use:

```text
@sepo-agent /create-action create a monitoring job for ...
```

The route runs the normal implementation workflow with a specialized prompt. The
pull request should add or update one standalone workflow under
`.github/workflows/`, usually named `agent-action-<short-slug>.yml`.

## Workflow shape

Generated action workflows use native GitHub Actions triggers instead of a custom
`.agent/actions` scheduler. The reusable template lives at:

```text
.agent/action-templates/agent-action-template.yml
```

Copy that template to `.github/workflows/agent-action-<short-slug>.yml` and fill
in the workflow name, cron, expiration date, lane, request text, and optional
issue-report target.

Generated workflows should:

- include `workflow_dispatch` for manual test runs
- include `schedule` only for automatic recurring work
- use `.github/actions/check-agent-action-expiration` before provider/runtime setup
- gate provider-backed steps with `if: steps.expiration.outputs.expired != 'true'`
- use `permission_mode: approve-all`, `memory_mode_override: read-only`, and `session_policy: track-only`
- use a unique lane such as `agent-action-<short-slug>`
- add `issues: write` only when setting `REPORT_ISSUE_NUMBER` for issue reporting

GitHub does not automatically expire scheduled workflows. The shared expiration
action validates a UTC `YYYY-MM-DD` date and compares dates without GNU-only
`date -d` parsing. Use a short expiration by default, such as 30 days from
creation, unless the user asks for a different date. Extending or removing an
expired workflow should happen through normal pull request review.

Do not generate `.agent/actions/*.yml` specs or a generic scheduler workflow.
Keep scheduling, expiration, and activation in the native workflow file so normal
PR review controls what becomes active.
