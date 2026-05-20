## Task Description

An explicit `/implement` request on a pull request or discussion needs a tracking issue before implementation can run.

Generate only the tracking issue metadata. The `/implement` command is already explicit approval to run implementation; do not decide or approve the route.

## Context Gathering

- Read the target context first:
  - For pull requests, run `gh pr view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,files,labels,reviews,reviewDecision,state,url`.
  - For discussions, run `node .agent/dist/cli/fetch-discussion-transcript.js ${TARGET_NUMBER}`.
- Use the request text, target title/body, and recent relevant discussion to infer the implementation task.
- Do not derive the title by copying the literal text after `/implement`.
- Ignore earlier prose mentions of `/implement` unless they are part of the current user request context.

Return exactly one JSON object and nothing else:

```json
{
  "issue_title": "Concise implementation title under 70 characters",
  "issue_body": "Structured markdown with goal, context, and acceptance criteria",
  "base_pr": "Optional positive integer PR number for stacked implementation"
}
```

Rules:
- Make `issue_title` a context-derived task title, not a command tail.
- Keep `issue_title` under 70 characters.
- Include enough context in `issue_body` for the implementation workflow to act without rereading every comment.
- Omit `base_pr` unless `TARGET_KIND` is `pull_request` and the current user request explicitly asks for a stacked or follow-up PR.
- When setting `base_pr`, set it to the current target pull request number (`TARGET_NUMBER`) as digits only, with no `#` prefix.
- If the current target pull request is closed or merged, omit `base_pr`; keep the closed PR link and useful context in `issue_body` instead.
- Do not infer `base_pr` from target title/body prose alone.
- If the task is ambiguous, describe the known request and the ambiguity in `issue_body`; still provide the best concise title.
