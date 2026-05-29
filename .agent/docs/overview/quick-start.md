---
title: "Quick start"
---

## Start from the template

1. Create a new repository with **Use this template**. Forking is supported, but forks often have Issues and/or Actions disabled by default; template-created repos usually avoid those fork-specific defaults.
2. Install the [Sepo GitHub App](https://github.com/apps/sepo-agent-app/installations/select_target). For first-time setup, choose **Only select repositories** and select the repository you are setting up.
3. Use the hosted Sepo App path unless your organization requires a self-managed GitHub App. See the [setup guide](../setup/setup-guide.md) for details.
4. Before onboarding, confirm the repository is ready:
   - **Issues** are enabled in `Settings > General > Features > Issues`.
   - **Actions** are enabled in `Settings > Actions > General`.
   - The Sepo GitHub App is installed for this repository.
   - At least one model-provider credential is configured under `Settings > Secrets and variables > Actions` as a repository secret: `OPENAI_API_KEY` for Codex-backed runs, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` for Claude-backed runs.
5. Run `Agent / Onboarding / Check Setup` from GitHub Actions. It creates the built-in `agent/*` trigger labels if they are missing and opens or updates an agent-tracked `Sepo setup check` issue with configuration status and copyable test commands.
6. Open an issue and mention `@sepo-agent` in the issue body or a comment. After a short delay, the workflow should add an eyes reaction and then post a response.

## Install into an existing repository

Use [Install into an existing repository](../setup/install-existing-repository.md) for the minimal non-template flow. It covers copying `.agent/` and `.github/`, configuring secrets, running the onboarding setup check, and bootstrapping `agent/memory` from GitHub Actions.

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
| Skill | Run a repository skill from `<skill_root>/<name>/SKILL.md`. | `@sepo-agent /skill <name>` |
| Install | Run the dedicated install route when Sepo can write to the target repository. | `@sepo-agent /install ...` |

You can also trigger the same built-in routes with labels:

| Label | Route |
|---|---|
| `agent/answer` | Answer |
| `agent/implement` | Implement |
| `agent/create-action` | Create action |
| `agent/review` | Review |
| `agent/fix-pr` | Fix PR |
| `agent/s/<name>` | Skill |

Only authorized repository users can trigger Sepo. By default, repositories allow `OWNER`, `MEMBER`, `COLLABORATOR`, and `CONTRIBUTOR` associations; public repositories can tighten this with `AGENT_ACCESS_POLICY`. See [Trigger access policy](../customization/access-policy.md) to customize that behavior.

`Agent / Onboarding / Check Setup` creates the built-in labels listed above. Custom skill labels still use the `agent/s/<name>` pattern and can be created as needed.
