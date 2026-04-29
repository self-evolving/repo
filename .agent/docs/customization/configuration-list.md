# Configurations list

## Repository variables

| Variable | Purpose |
|---|---|
| `AGENT_HANDLE` | Override the mention handle. Defaults to `@sepo-agent`. |
| `AGENT_RUNS_ON` | JSON array string for runner selection. If you are using self-hosted runners, see [Self-hosted GitHub Action runner](../deployment/self-hosted-github-action-runner.md). |
| `AGENT_DEFAULT_PROVIDER` | Default provider for single-agent runs and review synthesis: `auto`, `codex`, or `claude`. Explicit `codex` / `claude` choices are honored even without matching repository secrets, allowing self-hosted runners to use local provider authentication. `auto` chooses the first configured provider secret, preferring Codex when both secrets are present. |
| `AGENT_SESSION_BUNDLE_MODE` | Default session-bundle behavior: `auto`, `always`, or `never`. For the trade-offs behind this setting, see [Session continuity](../technical-details/session-continuity.md). |
| `AGENT_AUTOMATION_MODE` | Post-action orchestration mode: `disabled` by default, `heuristics` for the built-in state machine, or `agent` for a planner-backed orchestrator validated by runtime policy. Compatibility aliases: `true` = `heuristics`, `false` = `disabled`. See [Agent orchestrator](../technical-details/agent-orchestrator.md). |
| `AGENT_AUTOMATION_MAX_ROUNDS` | Maximum number of automatic handoff rounds when automation mode is enabled. Defaults to `5`. |
| `AGENT_COLLAPSE_OLD_REVIEWS` | Review synthesis cleanup toggle. Defaults to enabled; set to `false` to leave older AI review synthesis summaries visible instead of minimizing them as outdated. |
| `AGENT_STATUS_LABEL_ENABLED` | Set to `true` to apply the fixed `agent` status label to handled issues and pull requests. |
| `AGENT_ACCESS_POLICY` | JSON trigger allowlist policy. See [Trigger access policy](../access-policy.md). |
| `AGENT_MEMORY_POLICY` | JSON policy controlling which routes can read or write repository memory. See [Repository memory](../architecture/memory.md). |
| `AGENT_MEMORY_REF` | Default branch name used when workflows mount repository memory. Defaults to `agent/memory`. |
| `AGENT_SCHEDULE_POLICY` | JSON policy controlling scheduled workflow runs. See [Repository memory](../architecture/memory.md#scheduled-workflow-policy-agent_schedule_policy). |
| `AGENT_RUBRICS_POLICY` | JSON policy controlling which routes can read or write user/team rubrics. Defaults to read-only. See [User/team rubrics](../architecture/rubrics.md). |
| `AGENT_RUBRICS_REF` | Default branch name used when workflows mount user/team rubrics. Defaults to `agent/rubrics`. |
| `AGENT_RUBRICS_LIMIT` | Maximum selected rubrics injected into an agent prompt. Defaults to `10`. |
| `AGENT_COMMITTER_NAME` | Custom commit author name for implementation and PR-fix runs |
| `AGENT_COMMITTER_EMAIL` | Custom commit author email for implementation and PR-fix runs |

The bundled workflows intentionally expose one global provider variable. If a repository needs a route-specific provider, edit that route's `resolve-agent-provider` step in the workflow YAML and set `default_provider` or `route_provider` inline. The review workflow still launches explicit Claude and Codex reviewer lanes; `AGENT_DEFAULT_PROVIDER` controls the single synthesis step that combines whatever review artifacts were produced.

## Repository secrets

| Secret | Purpose |
|---|---|
| Model provider secrets | |
| `OPENAI_API_KEY` | Enable Codex-backed runs on runners without local Codex authentication; also lets `AGENT_DEFAULT_PROVIDER=auto` detect Codex |
| `CLAUDE_CODE_OAUTH_TOKEN` | Enable Claude-backed runs on runners without local Claude authentication; also lets `AGENT_DEFAULT_PROVIDER=auto` detect Claude |
| GitHub auth secrets |  |
| `AGENT_APP_ID` | Self-managed GitHub App ID for the bring-your-own-app path; set only with `AGENT_APP_PRIVATE_KEY`. The public Sepo App ID `3527007` is informational for hosted/OIDC usage. |
| `AGENT_APP_PRIVATE_KEY` | Self-managed GitHub App private key for the bring-your-own-app path |
| `AGENT_PAT` | PAT fallback for environments where app-based auth is not practical |


See [Setup guide](../deployment/setup-guide.md) for how token secrets are used.
