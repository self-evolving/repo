## Task Description

Fix pull request #${TARGET_NUMBER} to address review feedback and requested changes.

Trigger metadata:
- Triggering source kind: `${REQUEST_SOURCE_KIND}`
- Triggering comment/review ID: `${REQUEST_COMMENT_ID}`
- Triggering comment/review URL: `${REQUEST_COMMENT_URL}`
- Orchestrator handoff context, when this run was launched by automation:
  `${ORCHESTRATOR_CONTEXT}`

Instructions:
1. Work only on the existing PR branch. Do not create a new branch or a new PR.
2. Gather current PR context:
   - `gh pr view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,reviews,files,headRefOid,reviewDecision,state,url`
   - `gh api --paginate repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/comments`
   - `gh pr diff ${TARGET_NUMBER} --repo ${REPO_SLUG}`
3. If a triggering comment or review ID is present, fetch that exact request first:
   - For issue_comment: `gh api repos/${REPO_SLUG}/issues/comments/${REQUEST_COMMENT_ID}`
   - For pull_request_review_comment: `gh api repos/${REPO_SLUG}/pulls/comments/${REQUEST_COMMENT_ID}`
   - For pull_request_review: `gh api repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/reviews/${REQUEST_COMMENT_ID}`
4. Before editing, identify the latest actionable request. When
   `${ORCHESTRATOR_CONTEXT}` is non-empty, it is the exclusive authorized task;
   implement that selected task and do not add findings from elsewhere. The
   context may contain labeled synthesis items or prose from another supported
   handoff. Otherwise use this priority order without reviving superseded feedback:
   1. the exact triggering comment or review, when an ID is present;
   2. the latest review synthesis and its action items;
   3. recent human maintainer comments;
   4. older reviews/comments only when still applicable to the current diff.
5. Treat `FOLLOW_UP`, `HUMAN_DECISION`, optional suggestions, and already-fixed
   findings as non-actionable unless directly requested by a human trigger.
6. Make the smallest complete change within the PR's stated scope. If the task
   requires scope expansion or no authorized change remains, leave the tree
   unchanged and say so clearly in the JSON summary.
7. Run lightweight, directly relevant checks when they are clearly applicable.
8. If a line-specific clarification is useful, you may post an inline PR comment
   with `gh`, but do not post a top-level summary comment.
9. Do not commit. Leave changes in the working tree.

Return exactly one JSON object and nothing else:

```json
{
  "summary": "Concise GitHub-flavored markdown for the workflow logs and PR status comment.",
  "commit_message": "Concise commit message under 72 characters."
}
```

Format rules:
- `summary` should use concise GitHub-flavored markdown.
- Use bullet points for the main outcomes in `summary`.
- When there is secondary detail, prefer `<details><summary>...</summary>...</details>` blocks inside `summary`.
- `commit_message` should describe the actual fix made, not just the PR number.
- If you cannot determine a better commit message from the work performed, return an empty string for `commit_message` so the workflow can fall back to its default commit message.
- Keep `summary` brief and avoid a preamble.
