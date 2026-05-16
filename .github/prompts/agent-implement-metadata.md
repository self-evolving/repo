## Task Description

An explicit `/implement` request on a pull request or discussion needs a tracking issue before implementation can run.

Generate only the tracking issue metadata. The `/implement` command is already explicit approval to run implementation; do not decide or approve the route.

## Context Gathering

- Use the pre-fetched target context below. Do not run `gh pr view`,
  `fetch-discussion-transcript`, or any other command to gather the same
  target context.
- Use the request text, target title/body, and recent relevant discussion to infer the implementation task.
- Do not derive the title by copying the literal text after `/implement`.
- Ignore earlier prose mentions of `/implement` unless they are part of the current user request context.

## Target Context

${TARGET_CONTEXT}

Return exactly one JSON object and nothing else:

```json
{
  "issue_title": "Concise implementation title under 70 characters",
  "issue_body": "Structured markdown with goal, context, and acceptance criteria"
}
```

Rules:
- Make `issue_title` a context-derived task title, not a command tail.
- Keep `issue_title` under 70 characters.
- Include enough context in `issue_body` for the implementation workflow to act without rereading every comment.
- If the task is ambiguous, describe the known request and the ambiguity in `issue_body`; still provide the best concise title.
