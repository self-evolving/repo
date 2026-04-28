## Task Description

You are resuming a PR review synthesis session that hit the turn limit before
producing the final markdown.

Do not repeat the exploration work unless it is strictly necessary.
Use the existing session context and produce the final unified review synthesis
now.

Requirements:
- Output clean GitHub-flavored markdown only
- Do not output JSON
- Do not include a preamble
- Keep the same synthesis structure and verdict style as the original task,
  including:
  - `## Summary of PR/Issue`
  - `## Review` with the findings table
  - `## Progress`
  - `## Issue Details` with `<details>` blocks when applicable
  - `## Recommended Next Step`
  - `## Final Verdict`
  - `## Action Items`
- Check reviews and comments already posted by other agents before finalizing,
  and incorporate them into the synthesis.
- If the session already identified line-specific issues that still need inline
  PR comments, first check whether there are already existing inline review
  comments on those issues with `gh api --paginate
  repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments`.
- Do not post more inline comments until you have checked the existing inline
  comments and confirmed the new comment would not be a duplicate.
- If you post inline comments, use:
  `gh api --method POST repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments -f body='<comment>' -f commit_id='<headRefOid>' -f path='<path>' -F line=<line> -f side=RIGHT`
  and do not post the full synthesis or a separate summary comment
