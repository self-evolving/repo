# AGENT.md

This repository contains a GitHub-native agent runtime and workflow scaffold for a self-evolving repository: agents can answer questions, implement issues, review and fix PRs, and maintain repository memory through GitHub Actions. See `.agent/docs/` for detailed architecture, setup, customization, memory, and workflow documentation.

Use the agent either by asking it to respond in GitHub or by launching an action explicitly:

- **Direct response:** mention `@sepo-agent` in an issue, PR, discussion, or comment, optionally with `/answer`, `/implement`, `/update`, `/review`, `/fix-pr`, `/orchestrate`, or `/skill <name>`.
- **Launch an action with `gh`:** run the relevant workflow with inputs, for example `gh workflow run agent-implement.yml -f issue_number=<issue-number>`, `gh workflow run agent-update.yml`, or `gh workflow run agent-review.yml -f pr_number=<pr-number>`.

The `agent/memory` branch contains agent project memories such as project context, durable conventions, daily activity notes, and mirrored GitHub issues, PRs, and discussions. If needed, set it up locally with `npm --prefix .agent ci`, `npm --prefix .agent run build`, `npm --prefix .agent run bootstrap:memory -- --repo <owner/repo>`, then `git push origin agent/memory`; see `.agent/docs/architecture/memory.md` for details.

The `agent/rubrics` branch contains user/team preferences that normal implementation and review runs can read, while dedicated rubrics workflows validate and update that branch.
