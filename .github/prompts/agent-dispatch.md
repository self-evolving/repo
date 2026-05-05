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
- `create-action`: request approval to create a scheduled GitHub Actions workflow for recurring agent automation
- `setup`: produce a plan-only Sepo setup diff from a setup issue; only valid for `issue`
- `unsupported`: explain the limitation inline

Return exactly one JSON object and nothing else:

```json
{
  "route": "answer | implement | fix-pr | review | create-action | setup | unsupported",
  "needs_approval": true,
  "summary": "One short sentence for the user describing what the agent will do next.",
  "confidence": "low | medium | high",
  "issue_title": "",
  "issue_body": ""
}
```

Rules:
- Use `implement` when the user is explicitly asking the agent to make code changes.
- Use `fix-pr` when the user is explicitly asking the agent to update an existing PR to address review feedback or requested changes.
- Use `review` only when the user is explicitly asking for a PR review or another review pass.
- Use `create-action` when the user asks to create an automatically running or durable automation, monitor, scheduled job, or recurring check.
- Use `setup` only for plan-only setup requests, especially `@sepo-agent /setup plan` on a Sepo setup issue. Do not use it for apply/create/link requests; explicit `/setup apply` is resolved locally without this dispatch model.
- Use `answer` for questions, clarification, lightweight analysis, or discussion.
  - Sometimes the user may also ask the agent to review some code (and the user could be explicit about just review and launch a review agent). In this case, we should also resolve to `answer`.
- Use `unsupported` when the user asks for a workflow this repo does not support yet.
- `fix-pr` is only valid for `pull_request` targets. If the request is not on a pull request, use `unsupported`.
- `setup` is only valid for `issue` targets. If an implicit setup request asks to apply changes, create/link Projects, or mutate repository variables, use `unsupported`; only the exact explicit `/setup apply` command may apply allowlisted repository variables.
- Keep `summary` short and user-facing.
- When `route` is `implement` or `create-action`, always populate `issue_title` (concise, under 70 chars)
  and `issue_body` (structured markdown with goal, acceptance criteria, and any
  relevant context from the original message). These will be used to create a
  tracking issue that the user can review and edit before approving.
- When `route` is not `implement` or `create-action`, leave `issue_title` and `issue_body` empty.
