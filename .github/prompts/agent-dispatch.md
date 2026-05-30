## Task Description

The user mentioned the agent on GitHub and your task is to infer user intention and triage to specific routes:

The message that mentioned the agent:
${MENTION_BODY}

## Instruction

Choose exactly one route:
- `answer`: answer inline now
- `implement`: request approval to run the implementation workflow
- `fix-pr`: start the PR-fix workflow immediately; only valid for `pull_request`
- `review`: start the review workflow immediately; only valid for `pull_request`
- `orchestrate`: start the orchestrator workflow immediately; only valid for `issue` or `pull_request`
- `create-action`: request approval to create a scheduled GitHub Actions workflow for recurring agent automation
- `unsupported`: explain the limitation inline

Return exactly one JSON object and nothing else:

```json
{
  "route": "answer | implement | fix-pr | review | orchestrate | create-action | unsupported",
  "needs_approval": true,
  "summary": "One short sentence for the user describing what the agent will do next.",
  "confidence": "low | medium | high",
  "issue_title": "",
  "issue_body": ""
}
```

Rules:
- Use `implement` when the user is explicitly asking the agent to make code changes.
  - Prioritize the live mention over the target issue or pull request body. Existing context can explain what the work is, but it must not by itself turn a discussion-shaped mention into `implement`.
  - Choose `implement` only when the live mention clearly authorizes changes, such as "implement", "add", "update", "fix", "create", "change", or an explicit `/implement` command.
- Use `fix-pr` when the user is explicitly asking the agent to update an existing PR to address review feedback or requested changes.
- Use `review` only when the user is explicitly asking for a PR review or another review pass.
- Use `orchestrate` when the user explicitly asks for orchestration, follow-up automation, or a bounded multi-step agent workflow on an issue or pull request.
- Use `create-action` when the user asks to create an automatically running or durable automation, monitor, scheduled job, or recurring check.
- Use `answer` for questions, clarification, lightweight analysis, or discussion.
  - Default to `answer` for planning, design discussion, investigation, diagnosis, "let's think", "best way", "figure out why", "plans", "check", "look into", or similar wording unless the live mention also clearly asks the agent to make changes.
  - If the user asks the agent to "check whether", "check how", "look into whether", or "investigate how" to change something, use `answer`.
  - Sometimes the user may also ask the agent to review some code (and the user could be explicit about just review and launch a review agent). In this case, we should also resolve to `answer`.
- When in doubt, use `answer` with a plan and ask the user for an explicit `/implement` request or approval before changing code.
- Use `unsupported` when the user asks for a workflow this repo does not support yet.
- `fix-pr` is only valid for `pull_request` targets. If the request is not on a pull request, use `unsupported`.
- `orchestrate` is only valid for `issue` and `pull_request` targets. If the request is on another target kind, use `unsupported`.
- Keep `summary` short and user-facing.
- When `route` is `implement` or `create-action`, always populate `issue_title` (concise, under 70 chars)
  and `issue_body` (structured markdown with goal, acceptance criteria, and any
  relevant context from the original message). These will be used to create a
  tracking issue that the user can review and edit before approving.
- When `route` is not `implement` or `create-action`, leave `issue_title` and `issue_body` empty.

Examples:
- Mention: `@sepo-agent let's think about the best way to do it`
  Route: `answer`
  Reason: this asks for planning and discussion, even if the issue body describes an implementable change.
- Mention: `@sepo-agent shall we figure out why and plans for improvement?`
  Route: `answer`
  Reason: this asks for diagnosis and a plan, not code changes.
- On a concrete goal issue, mention: `@sepo-agent check and update the OpenAI API`
  Route: `implement`
  Reason: "update" clearly authorizes code or dependency changes. If the mention were `check whether/how to update the OpenAI API`, route to `answer`.
