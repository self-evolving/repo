# Sepo

Mention `@sepo-agent` on a GitHub issue, pull request, or discussion to answer questions, implement issues, review PRs, fix PR branches, or create durable scheduled agent workflows. Sepo runs inside GitHub Actions and keeps working context in repository-owned branches, so collaboration stays in GitHub instead of moving to a separate chat surface.

Sepo turns a repository into a **self-evolving repository**: a codebase that can react to user requests, preserve agent-facing memory and user/team rubrics, and improve both application code and its own automation over time. For the concept behind that architecture, see [What is a self-evolving repository?](.agent/docs/overview/what-is-self-evolving-repo.md).

![Sepo overview](.agent/docs/assets/sepo-overview.png)

```mermaid
flowchart LR
  user[GitHub user] --> trigger[Mention, label, schedule, or workflow dispatch]
  trigger --> router[Agent router]
  router --> route{Selected route}
  route --> answer[Answer]
  route --> implement[Implement]
  route --> review[Review]
  route --> fix[Fix PR]
  route --> action[Create action]
  route --> skill[Skill]
  answer --> github[GitHub comment or PR]
  implement --> github
  review --> github
  fix --> github
  action --> github
  skill --> github
  github --> memory[agent/memory and agent/rubrics]
  memory --> router
```

## Quick Start

### Start from this template

1. Fork this repository or use it as a template.
2. Install the [Sepo GitHub App](https://github.com/apps/sepo-agent-app) and ensure GitHub Actions is enabled for your repository.
3. Choose a GitHub authentication path:
   - Use the built-in hosted app/OIDC path for the simplest setup.
   - Use [your own GitHub App](.agent/docs/deployment/using-your-own-github-app.md) when you want a self-managed app identity.
   - See the [setup guide](.agent/docs/deployment/setup-guide.md) for all auth options and trade-offs.
4. Add at least one model-provider credential as a repository secret:
   - `OPENAI_API_KEY` for Codex-backed runs.
   - `CLAUDE_CODE_OAUTH_TOKEN` for Claude-backed runs.
5. Open an issue and mention `@sepo-agent` in the issue body or a comment. After a short delay, the workflow should add an eyes reaction and then post a response.

### Install into an existing repository

Use [Install into an existing repository](.agent/docs/deployment/install-existing-repository.md) for the minimal non-template flow. It covers copying `.agent/` and `.github/`, configuring secrets, and bootstrapping `agent/memory` from GitHub Actions.

## What You Can Ask It To Do

Use a free-form mention when you want the router to infer the best route:

```md
@sepo-agent can you explain how review synthesis works?
```

Use an explicit slash route when you already know the action:

| Action | Use it for | Syntax |
|---|---|---|
| Answer | Ask a question and get an inline response. | `@sepo-agent /answer ...` |
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

Only authorized repository users can trigger Sepo. By default, public repositories allow `OWNER`, `MEMBER`, and `COLLABORATOR`; private repositories also allow `CONTRIBUTOR`. See [Trigger access policy](.agent/docs/access-policy.md) to customize that behavior.

## How It Works

Every trigger converges on `agent-router.yml`, which extracts GitHub context, applies access policy, optionally triages free-form requests with a model, and dispatches to a specialized route. Agent sessions are persisted across runs with git refs and GitHub Actions artifacts, so a later mention can continue from prior context.

Durable context lives in two repository-owned branches:

- `agent/memory` mirrors GitHub artifacts and stores curated project context.
- `agent/rubrics` stores user/team preferences that guide implementation and review.

When automation mode is enabled, completed actions can hand back to `agent-orchestrator.yml`, a deterministic post-action boundary that manages follow-up review and fix loops with dedupe and max-round budgeting.

## Learn More

Getting started:

- [Quick start](.agent/docs/overview/quick-start.md)
- [Setup guide](.agent/docs/deployment/setup-guide.md)
- [Install into an existing repository](.agent/docs/deployment/install-existing-repository.md)

Understanding the system:

- [Overall design](.agent/docs/architecture/overall-design.md)
- [Supported workflows](.agent/docs/architecture/supported-workflows.md)
- [Agent actions](.agent/docs/actions/agent-actions.md)

Customizing and operating:

- [Configuration list](.agent/docs/customization/configuration-list.md)
- [Repository memory](.agent/docs/architecture/memory.md)
- [User/team rubrics](.agent/docs/architecture/rubrics.md)

See the [full documentation index](.agent/docs/README.md) for technical details, deployment options, and the complete docs tree.
