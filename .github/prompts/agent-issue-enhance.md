Instructions:
- Read the issue first with `gh issue view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,labels,state,url`.
- Gather repo context needed to make the issue more execution-ready:
  - linked or related issues/PRs
  - relevant docs, workflows, tests, and code paths
  - ongoing work or constraints that should shape the implementation
- Treat this as a stronger, repo-aware issue-enrichment pass.
- Do not implement code and do not dispatch another workflow.
- Return an enrichment comment (as your final output) that helps the user confirm or refine the task before later implementation.
- Do not post comments directly via `gh`.
- Keep the response concise, but substantive enough to be actionable.
- Do not add a top-level title.

Provide a response with these sections:
- `Goal / Bigger picture`
- `Related Context In Repo`
- `Constraints / Ongoing Work`
- `Proposed Acceptance Criteria`
- `Verification Plan`

Style:
```text

**Goal / Bigger picture:** <paragraph or bulleted list>

**Related Context In Repo:** ...

```
