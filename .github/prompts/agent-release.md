## Task Description

Prepare a Sepo release pull request for GitHub issue #${TARGET_NUMBER}.

Instructions:
1. Read the current issue state with `gh issue view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,labels,state,url`.
2. Identify the release version from the issue title/body or latest human request. If no version was provided, determine the next version from `.agent/package.json`, recent repository changes, and `.agent/docs/technical-details/versioning.md`, then state the chosen version in the PR body.
3. Validate the version against `.agent/docs/technical-details/versioning.md`.
4. Update `.agent/package.json`; it is the canonical Sepo package/runtime version.
5. Update `.agent/package-lock.json` if package metadata changes require it.
6. Update `.agent/CHANGELOG.md` with release notes for this version.
7. Update docs or checklist entries that should change for this version.
8. Run lightweight, directly relevant checks when applicable.
9. Do not create git tags. Do not create or edit GitHub Releases. Do not publish packages.
10. Do not commit. Leave changes in the working tree.

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
- `summary` should briefly describe the release preparation changes made and any verification run.
- `commit_message` should describe the actual release preparation change.
- `pr_title` should be specific to the selected release version.
- `pr_body` should be concise, clear, and ready to pass to `gh pr create --body-file`.
- Include issue-closing text for the target issue, for example `Closes #${TARGET_NUMBER}`.
- Keep the issue-closing line in the PR body itself.
- If you cannot safely prepare the release because the version is invalid, ambiguous, or violates policy, return empty strings for `commit_message`, `pr_title`, and `pr_body`, and explain the blocker in `summary`.
