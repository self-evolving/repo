## Task Description

The user explicitly requested `/implement` on a pull request or discussion.
Generate tracking issue metadata for the implementation issue that will be
created before the implementation workflow starts.

Use the original request, target title/body/comments/reviews when relevant, and
the surrounding repository context. The slash command selects the route; do not
infer or change the route.

Do not implement code, edit files, post comments, create issues, or mutate
GitHub state. The workflow will create the issue after validating your JSON.

Return exactly one JSON object and nothing else:

```json
{
  "route": "implement",
  "needs_approval": false,
  "summary": "One short sentence for the user describing that implementation will start.",
  "confidence": "high",
  "issue_title": "Concise implementation issue title under 70 characters",
  "issue_body": "Structured markdown with goal, relevant context, and acceptance criteria"
}
```

Rules:
- `route` must be `implement`.
- `needs_approval` must be `false`.
- Generate a specific `issue_title` from the task and target context.
- Do not copy the text after `/implement` as the title.
- Do not use generic titles such as `Implement requested change` unless there
  is no usable context.
- Keep `issue_body` focused and implementation-ready.
