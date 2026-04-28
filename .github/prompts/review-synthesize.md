## Task Description

You are synthesizing one or more independent code reviews of PR #${PR_NUMBER}.

Review outputs are available under `${REVIEWS_DIR}`. Use every review file you
find there. If only one review file exists, synthesize from that single
reviewer input without treating missing reviewers as an error. Do not infer
agreement, disagreement, or deduplication from missing reviewer outputs.

Use `gh pr view ${PR_NUMBER} --repo ${GITHUB_REPOSITORY} --json title,body,comments,reviews`
to inspect the current PR conversation before synthesizing.
Use `gh api --paginate repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments`
to inspect existing inline review comments before posting any new ones.

When a finding is concrete, actionable, and tied to a specific changed line,
post an inline PR comment with `gh` before returning the final synthesis. Use
inline comments sparingly:
- only for file/line-specific issues that merit direct reviewer feedback
- do not duplicate points that are already clearly covered in the PR discussion
- do not duplicate useful feedback already posted by other agents in PR reviews,
  top-level comments, or inline comments
- before posting, fetch existing inline review comments and skip any that
  already cover the same file/line issue well enough
- do not post the full synthesis, a top-level summary, or a separate overall PR
  comment with `gh`; the workflow posts the final synthesis itself
- if needed, use `gh pr view ${PR_NUMBER} --repo ${GITHUB_REPOSITORY} --json files,headRefOid` and
  `gh api --paginate repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments`
  to compare against existing feedback before posting
- post new inline comments with this command shape:
  `gh api --method POST repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments -f body='<comment>' -f commit_id='<headRefOid>' -f path='<path>' -F line=<line> -f side=RIGHT`

Produce a unified review synthesis:
1. Deduplicate overlapping findings and note meaningful reviewer disagreements
2. Prioritize BLOCKING > WARNING > INFO and use those exact severity labels
3. Make the top of the synthesis easy to scan before readers open details
4. Add a "Progress" section describing what is already acknowledged or fixed
5. Add a "Recommended Next Step" section that labels the ideal next step for
   automation and humans
6. End with a final verdict: SHIP / MINOR_ISSUES / NEEDS_REWORK
7. End with an "Action items" section as a GitHub checkbox list (`- [ ]`)

Format as clean GitHub-flavored markdown with this structure:

## Summary of PR/Issue
- 3-5 sentences summarizing what the PR is trying to do and why

## Review
- 1-3 sentences with the overall judgment
- Then a findings table with exactly these columns:

| Issue | Severity | Description |
| -- | -- | -- |
| ... | BLOCKING/WARNING/INFO | 1-2 sentences max |

## Progress
- Brief bullets for anything already acknowledged, fixed, or intentionally left
  out of scope

## Issue Details
- For each actionable issue in the table, add one `<details>` block whose
  summary starts with the same issue title used in the table
- Keep each block concise and focused
- Within each block, use:
  - `**Cause:**`
  - `**Candidate solutions:**`
  - `**Comments:**` only when it adds real value, such as reviewer
    disagreement, rollout risk, or fix status

## Recommended Next Step
- Exactly one of:
  - `FIX_PR`: unresolved findings require a concrete branch change and are safe
    for an automated fix-pr pass.
  - `HUMAN_DECISION`: remaining concerns are metadata-only, optional, product or
    style judgment, ambiguous, or need maintainer choice before more automation.
  - `NO_AUTOMATED_ACTION`: no unresolved actionable work remains.
- Include one sentence explaining why.

## Final Verdict
- `SHIP`, `MINOR_ISSUES`, or `NEEDS_REWORK`

## Action Items
- GitHub checkbox list using `- [ ]`
- Include only required, concrete branch-change work in checkboxes. Keep optional
  INFO notes, metadata-only cleanup, and human-judgment nits out of automation
  action items unless the PR request explicitly makes them required.

If there are no actionable issues, include a single findings-table row that says
so, omit "Issue Details", set Recommended Next Step to `NO_AUTOMATED_ACTION`,
and keep the verdict consistent with that outcome.

Do not include a preamble.
