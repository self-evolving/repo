## Task Description

Prepare a Sepo release pull request from GitHub issue #${TARGET_NUMBER}.

Instructions:
1. Start by reading the current issue state with `gh issue view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,labels,state,url`. Also read linked release/versioning context when the issue references it.
2. Identify whether the workflow provided an explicit version in the issue title/body.
3. If a version was provided, prepare that exact version. If no version was provided, inspect `.agent/package.json`, recent changes, and `.agent/docs/technical-details/versioning.md`; choose the next version and explain the choice in the PR body.
4. Validate the release version against `.agent/docs/technical-details/versioning.md`.
5. Update `.agent/package.json`; it is the canonical Sepo package/runtime version.
6. Update `.agent/package-lock.json` if package metadata changes require it.
7. Update `.agent/sepo-version.json` only if the version field still exists there, and keep `.agent/package.json` as the canonical version authority.
8. Update release documentation or checklist entries that should change for this version.
9. Run lightweight, directly relevant checks when applicable.
10. Do not create git tags. Do not create or edit GitHub Releases. Do not publish packages.
11. Do not commit. Leave changes in the working tree.

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
- `pr_title` should be specific to the prepared release version.
- `pr_body` should be concise, clear, and ready to pass to `gh pr create --body-file`.
- Include issue-closing text for the target issue, for example `Closes #${TARGET_NUMBER}`.
- Keep the issue-closing line in the PR body itself.
- If you cannot safely prepare the release because the explicit version is invalid or the next version cannot be chosen under policy, return empty strings for `commit_message`, `pr_title`, and `pr_body`, and explain the blocker in `summary`.
