## Task Description

Implement GitHub issue #${TARGET_NUMBER}.

Instructions:
1. Start by reading the current issue state with `gh issue view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,labels,state,url`. Please also check the broader project context.
2. Make the smallest complete change that resolves the issue.
3. Run lightweight, directly relevant checks when they are clearly applicable.
4. Do not commit. Leave changes in the working tree.

Return exactly one JSON object and nothing else:

```json
{
  "summary": "One short paragraph for the workflow logs and issue comment.",
  "commit_message": "Concise commit message under 72 characters.",
  "pr_title": "Concise pull request title under 72 characters.",
  "pr_body": "GitHub-flavored markdown pull request body."
}
```

Rules:
- `summary` should briefly describe the code changes made and any verification run.
- `commit_message` should describe the actual code change, not just the issue number.
- `pr_title` should be specific to the actual change, not just the issue number.
- `pr_body` should be concise, clear, and ready to pass to `gh pr create --body-file`.
- If you cannot determine a better commit message from the work performed, return an empty string for `commit_message` so the workflow can fall back to its default commit message.
- When you return a non-empty `pr_body` for an issue-backed implementation like this one, include GitHub issue-closing text for the target issue, for example `Closes #${TARGET_NUMBER}`.
- Keep the issue-closing line in the PR body itself, not only in `summary`.
- If you cannot determine better PR metadata from the work performed, return empty strings for `pr_title` and `pr_body` so the workflow can fall back to its default PR title/body.
