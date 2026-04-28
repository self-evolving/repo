# Self-evolving repository

<!-- Imagine a code repository that can react automatically in response to your requests or even improve autonomously.  -->

This repo uses GitHub-native primitives — Actions, issues, pull requests, labels, and discussions — to build a full-fledged [agentic system](https://notes.szj.io/thoughts/four-tiers-of-llm-applications#tier-4-multi-agent-system) around the idea of a **self-evolving repository**: _code that can improve itself autonomously and continuously learn from user feedback._

In addition to the code, a self-evolving repository contains:
- a schema for organizing development artifacts beyond source files — memories, interaction histories, user preferences, plans, rubrics, and other agent-facing context — much like `just`, `make`, or `cmake` help organize how code gets run, but aimed at traceability, reproducibility, and efficiency in agent development
- a way to launch agents and collaborate with them so the repository can improve both its application code and its own development workflow over time

In that sense, the repository is no longer a static artifact. It becomes a living system that can accumulate context, respond to feedback, and evolve alongside development.

Key concepts:
<details>
<summary>GitHub-native agent sessions</summary>
<ul>
  <li>Mention the agent in a GitHub issue, PR, or discussion — it answers or does the work in place.</li>
  <li>Agent sessions run in GitHub Actions; no separate chat tool or session manager needed.</li>
</ul>
</details>
<details>
<summary>Self-evolution</summary>
<ul>
  <li>The repository can keep track of agent-facing development artifacts such as memories, histories, and preferences in a way that improves traceability and reproducibility.</li>
  <li>It can also launch agents and collaborate with them to improve both the target codebase and the surrounding agent infrastructure.</li>
</ul>
</details>
<details><summary>Grow with the users</summary>TBD</details>


## Quick start

<details>
<summary>
<strong>Starting a new self-evolving repo: two steps</strong>
</summary>
<ul>
  <li>Fork this repository or use it as a template</li>
  <li>Install the <a href="https://github.com/apps/sepo-agent-app">Sepo GitHub App</a></li>
  <li>Ensure GitHub Actions is enabled for your repo</li>
  <li>Set <code>OPENAI_API_KEY</code> and/or <code>CLAUDE_CODE_OAUTH_TOKEN</code> as repository secrets (for Codex or Claude agent use)</li>
</ul>
</details>
<details>
<summary>
<strong>Alternative: installing to an existing repository</strong>
</summary>
<ul>
  <li>Copy <code>.agent/</code> and the current <code>.github/</code> directory into the target repository</li>
  <li>Configure the required secrets and auth path</li>
  <li>Use <a href=".agent/docs/deployment/install-existing-repository.md">Install into an existing repository</a> for the minimal non-template flow, including GitHub Actions-based <code>agent/memory</code> bootstrap and an optional local fallback</li>
</ul>
</details>

<!-- Add illustration -->

### Test the installation

There are several ways to trigger the agents, but the simplest way to test the setup is to create an issue and mention `@sepo-agent` in the text. Wait for the 👀 reaction after a short delay: that means the agent was triggered successfully and is running in the background. It should respond shortly.

## Feature overview

### Triggering agents to act

Trigger the agent to answer questions, implement features, review PRs, and more — either by mentioning it in a comment or by applying an `agent/*` label:

| Category | Syntax |
|---|---|
| **Mention an agent** | 
| - Free-form mention | `@sepo-agent [free-form-text]` — the dispatcher picks a route from your message |
| - Mention to run pre-defined actions | `@sepo-agent /<action>` where `<action>` is one of:<br>`/answer` — reply inline.<br>`/implement` — propose and implement an issue as a new PR.<br>`/review` — dual-agent PR review (PR only).<br>`/fix-pr` — push fixes to the current PR branch (PR only).<br>|
| - Mention to run with agent skills | `@sepo-agent /skill <name>` — runs the agent using `.skills/<name>/SKILL.md` as the prompt. |
| **Add agent labels** | <!-- *Apply to an issue or PR to trigger the agent without a live mention* --> |
| - Predefined action labels | `agent/answer`, `agent/implement`, `agent/review`, `agent/fix-pr` — same behavior as the matching slash command. |
| - Skill labels | `agent/s/<name>` — runs `.skills/<name>/SKILL.md` as the prompt. |

Only collaborators (i.e., OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR github roles) can trigger the agent.

### Autonomous agent actions

[TBD]

## How it works

Every trigger — a mention, a label, or an approval command — converges on a single portal workflow (`agent-router.yml`) that extracts context, optionally triages with an LLM, and dispatches to a specialized route (`answer`, `implement`, `fix-pr`, `review`, `skill`). Agent sessions are persisted across runs via git refs and GitHub Actions artifacts, so the same thread can be resumed on a fresh runner. Normal work and review runs can also mount `agent/rubrics` so current user/team preferences steer implementation and rubric review.

## Documentation

The documentation tree now lives under [`.agent/docs/`](.agent/docs/README.md):

- [Quick Start](.agent/docs/overview/quick-start.md)
- [Architecture](.agent/docs/architecture/overall-design.md)
- [Repository Memory](.agent/docs/architecture/memory.md)
- [User/team Rubrics](.agent/docs/architecture/rubrics.md)
- [Technical Details](.agent/docs/technical-details/key-concepts.md)
- [Agent Actions](.agent/docs/actions/README.md)
- [Customization](.agent/docs/customization/configuration-list.md)
- [Deployment](.agent/docs/deployment/README.md)
