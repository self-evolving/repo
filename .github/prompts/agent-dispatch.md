## Task Description

The user mentioned the agent on GitHub and your task is to infer user intention and triage to specific routes:

The message that mentioned the agent:
${MENTION_BODY}

## Instruction

Choose exactly one route:
${DISPATCH_ROUTE_LIST}

Return exactly one JSON object and nothing else:

```json
{
  "route": "${DISPATCH_ROUTE_UNION}",
  "needs_approval": true,
  "summary": "One short sentence for the user describing what the agent will do next.",
  "confidence": "low | medium | high",
  "issue_title": "",
  "issue_body": ""
}
```

Rules:
${DISPATCH_ROUTE_RULES}
- Keep `summary` short and user-facing.
- When `route` is `implement` or `create-action`, always populate `issue_title` (concise, under 70 chars)
  and `issue_body` (structured markdown with goal, acceptance criteria, and any
  relevant context from the original message). These will be used to create a
  tracking issue that the user can review and edit before approving.
- When `route` is not `implement` or `create-action`, leave `issue_title` and `issue_body` empty.
