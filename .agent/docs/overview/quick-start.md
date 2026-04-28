# Quick start

## Starting a new self-evolving repo

1. Fork this repository or use it as a template.
2. Install the [Sepo GitHub App](https://github.com/apps/sepo-agent-app).
3. Ensure GitHub Actions is enabled for your repo.
4. Set `OPENAI_API_KEY` and/or `CLAUDE_CODE_OAUTH_TOKEN` as repository secrets for Codex or Claude-backed agent runs.

## Alternative: install into an existing repository

Use the dedicated guide: [Install into an existing repository](../deployment/install-existing-repository.md).

## Test the installation

Create an issue and mention `@sepo-agent` in the text. After a short wait the workflow should react with `👀`, which indicates the agent has been triggered and is running in the background.

## Feature overview

### Mention-based triggers

| Category | Syntax |
|---|---|
| Free-form mention | `@sepo-agent [free-form-text]` |
| Explicit route | `@sepo-agent /answer`, `/implement`, `/create-action`, `/review`, `/fix-pr` |
| Skill route | `@sepo-agent /skill <name>` |

### Label-based triggers

| Category | Syntax |
|---|---|
| Built-in labels | `agent/answer`, `agent/implement`, `agent/create-action`, `agent/review`, `agent/fix-pr` |
| Skill labels | `agent/s/<name>` |

Only collaborators (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`) can trigger the agent.
