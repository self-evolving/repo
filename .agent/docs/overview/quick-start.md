# Quick Start

## Start from the template

1. Fork this repository or use it as a template.
2. Install the [Sepo GitHub App](https://github.com/apps/sepo-agent-app/installations/select_target) and ensure GitHub Actions is enabled for the repository.
3. Choose a GitHub authentication path:
   - Use the built-in hosted app/OIDC path for the simplest setup. Do not set `AGENT_APP_ID` / `AGENT_APP_PRIVATE_KEY` for this path; those secrets are only for a self-managed app.
   - Use [your own GitHub App](../deployment/using-your-own-github-app.md) when you want a self-managed app identity.
   - See the [setup guide](../deployment/setup-guide.md) for all auth options and trade-offs.
4. Add at least one model-provider credential as a repository secret:
   - `OPENAI_API_KEY` for Codex-backed runs.
   - `CLAUDE_CODE_OAUTH_TOKEN` for Claude-backed runs.
5. Open an issue and mention `@sepo-agent` in the issue body or a comment. After a short delay, the workflow should add an eyes reaction and then post a response.

## Install into an existing repository

Use [Install into an existing repository](../deployment/install-existing-repository.md) for the minimal non-template flow. It covers copying `.agent/` and `.github/`, configuring secrets, and bootstrapping `agent/memory` from GitHub Actions.

## Trigger Sepo

Use a free-form mention when you want the router to infer the best route:

```md
@sepo-agent can you explain how review synthesis works?
```

Use an explicit slash route when you already know the action:

| Action | Use it for | Syntax |
|---|---|---|
| Answer | Ask a question, or request plan-only procedure guidance before coding. | `@sepo-agent /answer ...` |
| Implement | Turn an issue request into a branch and draft PR. | `@sepo-agent /implement ...` |
| Create action | Propose a standalone scheduled agent workflow through a PR. | `@sepo-agent /create-action ...` |
| Review | Run the dual-agent PR review flow. | `@sepo-agent /review` |
| Fix PR | Push fixes to the current PR branch. | `@sepo-agent /fix-pr` |
| Skill | Run a repository skill from `.skills/<name>/SKILL.md`. | `@sepo-agent /skill <name>` |

You can also trigger the same built-in routes with labels:

| Label | Route |
|---|---|
| `agent/answer` | Answer |
| `agent/implement` | Implement |
| `agent/create-action` | Create action |
| `agent/review` | Review |
| `agent/fix-pr` | Fix PR |
| `agent/s/<name>` | Skill |

Only authorized repository users can trigger Sepo. By default, repositories allow `OWNER`, `MEMBER`, `COLLABORATOR`, and `CONTRIBUTOR` associations; public repositories can tighten this with `AGENT_ACCESS_POLICY`. See [Trigger access policy](../access-policy.md) to customize that behavior.
