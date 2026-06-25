---
title: "Configurations list"
---

## Repository variables

| Variable | Purpose |
|---|---|
| `AGENT_HANDLE` | Override the mention handle. Defaults to `@sepo-agent`. |
| `AGENT_ENABLED` | Global Sepo pause switch. Defaults to enabled when unset; set exactly `false` to skip packaged `agent-*.yml` workflows and generated agent-action template jobs before checkout or provider setup. Normal CI workflows such as `test-scripts.yml` are not governed by this flag. |
| `AGENT_FOLLOWUP_INTENT_MODE` | Controls unmentioned follow-up detection on new issue/PR comments, new PR review comments, and submitted PR reviews whose target already has the fixed `agent` label. Defaults to `agent-label`; set to `disabled` or `false` to require explicit mentions only. Implicit follow-ups can only become inline `answer` responses or be ignored. |
| `AGENT_RUNS_ON` | JSON array string for runner selection. If you are using self-hosted runners, see [Self-hosted GitHub Action runner](../setup/self-hosted-github-action-runner.md). |
| `AGENT_DEFAULT_PROVIDER` | Default provider for single-agent runs and review synthesis: `auto`, `codex`, or `claude`. Explicit `codex` / `claude` choices are honored even without matching repository secrets, allowing self-hosted runners to use local provider authentication. `auto` chooses Codex when `OPENAI_API_KEY` is configured; otherwise it chooses Claude when either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is configured. |
| `AGENT_MODEL_POLICY` | Optional JSON policy for model/reasoning defaults, provider-specific model settings, and route overrides. It supports `default` for non-provider defaults, `providers.codex`, `providers.claude`, and `route_overrides`; reviewer lanes stay fixed as the built-in Claude/Codex matrix, while `review-synthesize` uses this policy. Use `AGENT_DEFAULT_PROVIDER` for the global/default provider. |
| `AGENT_DISPLAY_MODEL` | Optional `true` / `false` toggle for appending compact run metadata to direct agent response comments that use the standard response posting helpers. When enabled, the footer order is <code>provider &#124; model &#124; reasoning effort &#124; runner</code>; empty optional values are omitted, and an empty model is shown as `default model`. Defaults to `true`; set to `false` to hide the footer. |
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
| `AGENT_PROGRESS_POLICY` | JSON policy controlling live progress comments and thumbs-down cancellation. Defaults to `implement` and `fix-pr` enabled, `answer` report-only, and other routes disabled. Modes are `enabled`, `report-only`, and `disabled`. Explicit orchestration context defaults to `disabled` and only honors the orchestration-specific `orchestration_mode` opt-in. |
| `AGENT_MEMORY_POLICY` | JSON policy controlling which routes can read or write repository memory. See [Repository memory](../architecture/memory.md). |
| `AGENT_MEMORY_REF` | Default branch name used when workflows mount repository memory. Defaults to `agent/memory`. |
| `AGENT_SCHEDULE_POLICY` | JSON policy controlling scheduled workflow runs. By default, scheduled daily summaries are disabled while manual dispatch remains available. See [Repository memory](../architecture/memory.md#scheduled-workflow-policy-agent_schedule_policy). |
| `AGENT_RUBRICS_POLICY` | JSON policy controlling which routes can read or write user/team rubrics. Defaults to read-only. See [User/team rubrics](../architecture/rubrics.md). |
| `AGENT_RUBRICS_REF` | Default branch name used when workflows mount user/team rubrics. Defaults to `agent/rubrics`. |
| `AGENT_RUBRICS_LIMIT` | Maximum selected rubrics injected into an agent prompt. Defaults to `10`. |
| `AGENT_COMMITTER_NAME` | Custom commit author name for implementation and PR-fix runs |
| `AGENT_COMMITTER_EMAIL` | Custom commit author email for implementation and PR-fix runs |

Bundled model defaults live in `.agent/model-defaults.json` and are intentionally small and pinned:

| Provider | Default model |
|---|---|
| `codex` | `gpt-5.5` |
| `claude` | `claude-opus-4-8` |

Sepo does not maintain a general model catalog, and the resolver reads these defaults from the bundled file locally with no network access at run time. Updates to the file ship through `agent-update.yml` with the rest of `.agent/`. Use `AGENT_MODEL_POLICY` when a repository needs different models, route-specific choices, or reasoning effort overrides.

`AGENT_MODEL_POLICY` example:

```json
{
  "providers": {
    "codex": { "model": "gpt-5.5", "reasoning_effort": "xhigh" },
    "claude": { "model": "claude-opus-4-8", "reasoning_effort": "max" }
  },
  "route_overrides": {
    "answer": { "provider": "codex", "model": "gpt-5.4-mini", "reasoning_effort": "high" },
    "review-synthesize": { "provider": "claude" }
  }
}
```

For Codex GPT-5 models, Sepo accepts provider-neutral `model` plus `reasoning_effort` policy entries and passes the effective ACP model id to acpx. For example, `{ "model": "gpt-5.5", "reasoning_effort": "xhigh" }` is sent to Codex ACP as `gpt-5.5/xhigh`, matching the model ids advertised by the bundled `@zed-industries/codex-acp` adapter. If a Codex model already includes an effort suffix such as `gpt-5.5/xhigh`, Sepo treats that model id as authoritative and does not send a separate `thought_level` setting. Claude and unknown/custom Codex model ids keep using the separate reasoning-effort path.

The bundled workflows still keep native YAML escape hatches: an inline `route_provider` in a workflow's `resolve-agent-provider` step overrides `AGENT_MODEL_POLICY` for that route. Provider selection precedence is inline `route_provider`, then `AGENT_MODEL_POLICY.route_overrides[route].provider`, then `AGENT_DEFAULT_PROVIDER`, then `auto` detection from configured provider secrets. Model selection starts from Sepo's built-in provider default, then applies `AGENT_MODEL_POLICY.default.model`, `AGENT_MODEL_POLICY.providers[provider].model`, and `AGENT_MODEL_POLICY.route_overrides[route].model`; inline `route_provider` skips that route's policy override. The review workflow still launches explicit Claude and Codex reviewer lanes; those lane providers are fixed with inline `route_provider`, so built-in/default/provider-specific model settings apply while route-specific review overrides do not. The synthesis step is resolved separately as `review-synthesize`.

`AGENT_PROGRESS_POLICY` example:

```json
{
  "default_mode": "disabled",
  "orchestration_mode": "report-only",
  "route_overrides": {
    "implement": "enabled",
    "fix-pr": "report-only",
    "answer": "report-only"
  }
}
```

`enabled` starts the progress comment and allows authorized 👎 cancellation. `report-only` starts the progress comment but ignores cancellation reactions. `disabled` preserves the normal run without a progress comment. Malformed policy disables progress for that run instead of failing the workflow. Orchestrated chains default to `disabled` progress mode and rely on handoff or status comments; set `orchestration_mode` to `report-only` to opt into non-cancellable progress comments for orchestrated runs. `enabled` is not accepted for `orchestration_mode` because cancellable chained-run semantics are not defined.

## Repository secrets

| Secret | Purpose |
|---|---|
| Model provider secrets | |
| `OPENAI_API_KEY` | Enable Codex-backed runs on runners without local Codex authentication; also lets `AGENT_DEFAULT_PROVIDER=auto` detect Codex. Sepo passes it through as `OPENAI_API_KEY` and mirrors it to acpx Codex auth aliases at runtime. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Enable Claude-backed runs on runners without local Claude authentication; also lets `AGENT_DEFAULT_PROVIDER=auto` detect Claude |
| `ANTHROPIC_API_KEY` | Enable Claude-backed runs with a direct Anthropic API key; also lets `AGENT_DEFAULT_PROVIDER=auto` detect Claude |
| GitHub auth secrets |  |
| `AGENT_APP_ID` | Self-managed GitHub App ID for the bring-your-own-app path; set only with `AGENT_APP_PRIVATE_KEY`. The public Sepo App ID `3527007` is informational for hosted/OIDC usage. |
| `AGENT_APP_PRIVATE_KEY` | Self-managed GitHub App private key for the bring-your-own-app path |
| `AGENT_PAT` | PAT fallback for environments where app-based auth is not practical |
| `AGENT_SECONDARY_GITHUB_TOKEN` | Optional read-only secondary fine-grained PAT exposed as `INPUT_SECONDARY_GITHUB_TOKEN` for explicit external repo context; does not replace the primary same-repo token |


See [Setup guide](../setup/setup-guide.md) for how token secrets are used.
