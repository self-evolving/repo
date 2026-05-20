# AGENT.md

This repository contains a GitHub-native agent runtime and workflow scaffold for a self-evolving repository: agents can answer questions, implement issues, review and fix PRs, and maintain repository memory through GitHub Actions. See `.agent/docs/` for detailed architecture, setup, customization, memory, and workflow documentation.

Use the agent either by asking it to respond in GitHub or by launching an action explicitly:

- **Direct response:** mention `@sepo-agent` in an issue, PR, discussion, or comment, optionally with `/answer`, `/implement`, `/review`, `/fix-pr`, `/orchestrate`, or `/skill <name>`.
- **Launch an action with `gh`:** run the relevant workflow with inputs, for example `gh workflow run agent-implement.yml -f issue_number=<issue-number>` or `gh workflow run agent-review.yml -f pr_number=<pr-number>`.

## Local coding agents

When using a local coding agent such as Codex or Claude, prepare the ignored local context workspace before substantial work:

```sh
npm --prefix .agent ci
npm --prefix .agent run build
npm --prefix .agent run prepare:local-agent -- --repo <owner/repo>
```

The command refreshes `.agent/local/memory` from `agent/memory`, `.agent/local/rubrics` from `agent/rubrics`, and writes `.agent/local/AGENT_CONTEXT.md` with the exact `MEMORY_DIR` / `RUBRICS_DIR` paths and local-agent operating notes. Missing memory or rubrics branches are non-fatal; run `Agent / Memory / Initialization` or `Agent / Rubrics / Initialization` from GitHub Actions when the context file reports that a branch is absent.

Local agents should read `AGENT.md`, memory, and applicable rubrics before implementation, then run focused checks and use a separate review/checking sub-agent after implementation when the local agent supports sub-agents.

The `agent/memory` branch contains agent project memories such as project context, durable conventions, daily activity notes, and mirrored GitHub issues, PRs, and discussions. If needed, set it up locally with `npm --prefix .agent ci`, `npm --prefix .agent run build`, `npm --prefix .agent run bootstrap:memory -- --repo <owner/repo>`, then `git push origin agent/memory`; see `.agent/docs/architecture/memory.md` for details.

The `agent/rubrics` branch contains user/team preferences that normal implementation and review runs can read, while dedicated rubrics workflows validate and update that branch.
