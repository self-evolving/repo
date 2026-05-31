---
title: "Configurations list"
---

## Repository variables

| Variable | Purpose |
|---|---|
| `AGENT_HANDLE` | Override the mention handle. Defaults to `@sepo-agent`. |
| `AGENT_ENABLED` | Global Sepo pause switch. Defaults to enabled when unset; set exactly `false` to skip packaged `agent-*.yml` workflows and generated agent-action template jobs before checkout or provider setup. Normal CI workflows such as `test-scripts.yml` are not governed by this flag. |
| `AGENT_RUNS_ON` | JSON array string for runner selection. If you are using self-hosted runners, see [Self-hosted GitHub Action runner](../setup/self-hosted-github-action-runner.md). |
| `AGENT_DEFAULT_PROVIDER` | Default provider for single-agent runs and review synthesis: `auto`, `codex`, `claude`, or `pi`. Explicit `codex` / `claude` / `pi` choices are honored even without matching repository secrets, allowing self-hosted runners to use local provider authentication. `auto` chooses Codex when `OPENAI_API_KEY` is configured, otherwise Claude when either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is configured, otherwise Pi when `PI_AUTH_JSON_B64` or `PI_AUTH_JSON` is configured. |
| `AGENT_MODEL_POLICY` | Optional JSON policy for model/reasoning defaults, provider-specific model settings, and route overrides. It supports `default` for non-provider defaults, `providers.codex`, `providers.claude`, `providers.pi`, and `route_overrides`; reviewer lanes stay fixed as the built-in Claude/Codex matrix, while `review-synthesize` uses this policy. Reasoning effort applies to Codex/Claude today; Pi currently supports configured model only. Use `AGENT_DEFAULT_PROVIDER` for the global/default provider. |
| `AGENT_DISPLAY_MODEL` | Optional `true` / `false` toggle for appending compact run metadata to direct agent response comments that use the standard response posting helpers. When enabled, the footer order is <code>provider &#124; model &#124; reasoning effort &#124; runner</code>; empty optional values are omitted, and an empty model is shown as `default model`. Defaults to `false`. |
| `AGENT_SESSION_BUNDLE_MODE` | Default session-bundle behavior: `auto`, `always`, or `never`. For the trade-offs behind this setting, see [Session continuity](../technical-details/session-continuity.md). |
| `AGENT_AUTOMATION_MODE` | Orchestrator decision mode. Defaults to `agent` for planner-backed orchestration validated by runtime policy. Set to `heuristics` for deterministic status-based routing with lower model cost. Compatibility alias: `true` = `heuristics`; explicit `false` or legacy `disabled` values fall back to `heuristics` for explicit `/orchestrate` chains. See [Agent orchestrator](../architecture/agent-orchestrator.md). |
| `AGENT_AUTOMATION_MAX_ROUNDS` | Maximum number of explicit orchestration handoff rounds. Defaults to `12`. |
| `AGENT_ALLOW_SELF_APPROVE` | Opt-in gate for `agent-self-approve.yml`. Defaults to `false`; when enabled, the workflow can approve only an open pull request whose current head matches trusted review synthesis provenance and the self-approval agent's inspected head. Same-actor approval is still blocked unless `AGENT_ALLOW_SELF_MERGE=true` is also enabled for full self-governance mode. |
| `AGENT_ALLOW_SELF_MERGE` | Opt-in gate for `agent-self-merge.yml`. Defaults to `false`; when enabled with self-approval, trusted current-head self-approved PRs can be marked ready and merged into their configured base with `--match-head-commit`. Together with `AGENT_ALLOW_SELF_APPROVE=true`, this allows Sepo-authored PRs to use an internal current-head self-approval status when GitHub review approval would be same-actor. |
| `AGENT_COLLAPSE_OLD_REVIEWS` | Generated comment cleanup toggle. Defaults to enabled; set to `false` to leave older AI review synthesis, rubrics review, `fix-pr` status, and orchestrator handoff comments visible instead of minimizing them as outdated. |
| `AGENT_STATUS_LABEL_ENABLED` | Set to `true` to apply the fixed `agent` status label to handled issues and pull requests. |
| `AGENT_PROJECT_MANAGEMENT_ENABLED` | Set to `true` to enable scheduled prompt-driven project-management runs. Manual runs can also use the workflow's `enabled` input. Defaults off. |
| `AGENT_PROJECT_MANAGEMENT_DRY_RUN` | Defaults project-management runs to dry-run mode. Defaults to `true`; set to `false` to apply validated managed-label plans when label application is enabled. |
| `AGENT_PROJECT_MANAGEMENT_APPLY_LABELS` | Defaults to `true`, allowing the deterministic post-agent step to update managed `priority/*` and `effort/*` labels when dry-run mode is disabled. Set to `false` to keep label application disabled even with dry-run off. |
| `AGENT_PROJECT_MANAGEMENT_POST_SUMMARY` | Set to `true` to have the final workflow step comment with the project-management summary on today's existing Daily Summary discussion. If the discussion is missing, only the Actions step summary is written. |
| `AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY` | Discussion category shared by Daily Summary discussion creation and project-management summary comments. Defaults to `General`. |
| `AGENT_PROJECT_MANAGEMENT_LIMIT` | Maximum open issues and pull requests for the agent to inspect per kind. Defaults to `100`. |
| `AGENT_AUTO_UPDATE` | Set to `false` to disable scheduled `agent-update.yml` checks. Defaults to enabled; manual workflow dispatch remains available. The canonical `self-evolving/repo` source repository should use this when scheduled self-updates are not wanted. |
| `AGENT_ACCESS_POLICY` | JSON trigger allowlist policy. See [Trigger access policy](access-policy.md). |
| `AGENT_TASK_TIMEOUT_POLICY` | JSON policy for GitHub Actions step timeouts on agent tasks. Defaults to `{"default_minutes":30}` and accepts route overrides, for example `{"default_minutes":30,"route_overrides":{"implement":60,"review":45}}`. Values must be 1-360 minutes. |
| `AGENT_MEMORY_POLICY` | JSON policy controlling which routes can read or write repository memory. See [Repository memory](../architecture/memory.md). |
| `AGENT_MEMORY_REF` | Default branch name used when workflows mount repository memory. Defaults to `agent/memory`. |
| `AGENT_SCHEDULE_POLICY` | JSON policy controlling scheduled workflow runs. By default, scheduled daily summaries are disabled while manual dispatch remains available. See [Repository memory](../architecture/memory.md#scheduled-workflow-policy-agent_schedule_policy). |
| `AGENT_RUBRICS_POLICY` | JSON policy controlling which routes can read or write user/team rubrics. Defaults to read-only. See [User/team rubrics](../architecture/rubrics.md). |
| `AGENT_RUBRICS_REF` | Default branch name used when workflows mount user/team rubrics. Defaults to `agent/rubrics`. |
| `AGENT_RUBRICS_LIMIT` | Maximum selected rubrics injected into an agent prompt. Defaults to `10`. |
| `AGENT_COMMITTER_NAME` | Custom commit author name for implementation and PR-fix runs |
| `AGENT_COMMITTER_EMAIL` | Custom commit author email for implementation and PR-fix runs |

`AGENT_MODEL_POLICY` example:

```json
{
  "providers": {
    "codex": { "model": "gpt-5.4", "reasoning_effort": "xhigh" },
    "claude": { "model": "claude-sonnet-4-5", "reasoning_effort": "max" },
    "pi": { "model": "gpt-5.4-mini" }
  },
  "route_overrides": {
    "answer": { "provider": "codex", "model": "gpt-5.4-mini", "reasoning_effort": "high" },
    "review-synthesize": { "provider": "claude" }
  }
}
```

The bundled workflows still keep native YAML escape hatches: an inline `route_provider` in a workflow's `resolve-agent-provider` step overrides `AGENT_MODEL_POLICY` for that route. Provider selection precedence is inline `route_provider`, then `AGENT_MODEL_POLICY.route_overrides[route].provider`, then `AGENT_DEFAULT_PROVIDER`, then `auto` detection from configured provider secrets. The review workflow still launches explicit Claude and Codex reviewer lanes; model policy applies to the single synthesis step that combines produced review artifacts, not to the reviewer lane matrix.

## Repository secrets

| Secret | Purpose |
|---|---|
| Model provider secrets | |
| `OPENAI_API_KEY` | Enable Codex-backed runs on runners without local Codex authentication; also lets `AGENT_DEFAULT_PROVIDER=auto` detect Codex. Sepo passes it through as `OPENAI_API_KEY` and mirrors it to acpx Codex auth aliases at runtime. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Enable Claude-backed runs on runners without local Claude authentication; also lets `AGENT_DEFAULT_PROVIDER=auto` detect Claude |
| `ANTHROPIC_API_KEY` | Enable Claude-backed runs with a direct Anthropic API key; also lets `AGENT_DEFAULT_PROVIDER=auto` detect Claude |
| `PI_AUTH_JSON_B64` | Optional base64-encoded Pi `auth.json` restored only for Pi-selected runs; Secret-only, never a repository Variable |
| `PI_AUTH_JSON` | Optional literal Pi `auth.json` restored only for Pi-selected runs; Secret-only, never a repository Variable |
| GitHub auth secrets |  |
| `AGENT_APP_ID` | Self-managed GitHub App ID for the bring-your-own-app path; set only with `AGENT_APP_PRIVATE_KEY`. The public Sepo App ID `3527007` is informational for hosted/OIDC usage. |
| `AGENT_APP_PRIVATE_KEY` | Self-managed GitHub App private key for the bring-your-own-app path |
| `AGENT_PAT` | PAT fallback for environments where app-based auth is not practical |
| `AGENT_SECONDARY_GITHUB_TOKEN` | Optional read-only secondary fine-grained PAT exposed as `INPUT_SECONDARY_GITHUB_TOKEN` for explicit external repo context; does not replace the primary same-repo token |


See [Setup guide](../setup/setup-guide.md) for how token secrets are used.

Pi auth restoration writes either `PI_AUTH_JSON_B64` or `PI_AUTH_JSON` to `$RUNNER_TEMP/pi-agent/auth.json`, sets `PI_CODING_AGENT_DIR` for the agent run, and fails if both secrets are configured. Prefer provider API keys such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for GitHub-hosted CI. `PI_AUTH_JSON` / `PI_AUTH_JSON_B64` are convenient for API-key-style Pi auth entries and testing, but Pi OAuth/subscription auth may rotate refresh tokens during a run; on ephemeral GitHub-hosted runners the updated file stays in `$RUNNER_TEMP` and the repository Secret keeps the old refresh token. Persistent self-hosted runners with local `~/.pi/agent/auth.json` are the better fit for OAuth/subscription refresh rotation.
