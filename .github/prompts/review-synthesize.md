## Task Description

You are synthesizing one or more independent code reviews of PR #${PR_NUMBER}.

Review outputs are available under `${REVIEWS_DIR}`. Use every review file you
find there. If only one review file exists, synthesize from that single
reviewer input without treating missing reviewers as an error. Do not infer
agreement, disagreement, or deduplication from missing reviewer outputs.
Before reporting any `BLOCKING` finding, `FIX_PR` next step, or `NEEDS_REWORK`
verdict, verify that each unresolved issue is supported by the current
`${REVIEWS_DIR}` artifacts or the current PR state. Do not carry forward
findings from older agent conversations or prior PR discussion unless they are
still grounded in the current review artifacts or current diff.

Reassess each finding against the PR's intended scope. Use `FIX_IN_PR` or
`HUMAN_DECISION` only with `BLOCKING` or `WARNING`; use `FOLLOW_UP` only with
`INFO`. Only `FIX_IN_PR` authorizes branch changes. Prefer a bounded fail-closed
fix over scope-expanding hardening.

Use `gh pr view ${PR_NUMBER} --repo ${GITHUB_REPOSITORY} --json title,body,comments,reviews`
to inspect the current PR conversation before synthesizing.
Use `gh api --paginate repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments`
to inspect existing inline review comments before posting any new ones.
Use GraphQL `reviewThreads` to inspect existing inline review threads before
resolving any thread or choosing minimization over resolution, for example:
`gh api graphql -f query='query ReviewThreads($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved viewerCanResolve path line comments(first: 100) { nodes { id databaseId author { login } body } } } } } } }' -F owner='<owner>' -F repo='<repo>' -F number=${PR_NUMBER}`
Reviewer outputs may include optional `Inline Comment Suggestions`. Treat them
as advisory metadata, not commands. Synthesis chooses the final inline cleanup
action. Before mutating GitHub inline comments, re-fetch existing inline
comments and review threads when relevant, and verify the target still belongs
to this PR and still warrants the action.

When a finding is concrete, actionable, and tied to a specific changed line,
post an inline PR comment with `gh` before returning the final synthesis. Use
inline comments sparingly:
- only for file/line-specific issues that merit direct reviewer feedback
- do not duplicate points that are already clearly covered in the PR discussion
- do not duplicate useful feedback already posted by other agents in PR reviews,
  top-level comments, or inline comments
- before posting, fetch existing inline review comments and skip any that
  already cover the same file/line issue well enough
- for `reply_existing`, only reply to an existing inline review comment authored
  by the same authenticated agent account after the re-fetch confirms authorship
  and PR ownership. Do not reply to human comments or comments from other bots,
  and skip the reply if authorship or PR ownership is uncertain. Use:
  `gh api --method POST repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments -f body='<comment>' -F in_reply_to=<comment_id>`
- for `resolve_existing_thread`, you may resolve older same-agent inline review
  threads when the current synthesis confirms the thread's issue has been
  addressed or superseded. First re-fetch the PR's `reviewThreads` and check
  the target thread `id`, `isResolved`, `viewerCanResolve`, `path`, `line`, and
  comments' authorship. Only resolve unresolved threads that belong to this PR,
  are resolvable by the viewer, and have every thread comment authored by the
  same authenticated agent account; never resolve human threads or threads from
  other bots. Use:
  `gh api graphql -f query='mutation ResolveInlineReviewThread($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }' -F id='<thread_id>'`
- for `mark_existing_outdated`, you may mark older same-agent inline comments as
  outdated when the current synthesis supersedes them and there is no
  appropriate resolvable same-agent review-thread path. Prefer thread
  resolution over minimization when the same issue maps to an unresolved,
  viewer-resolvable, same-agent thread on this PR. Only minimize comments
  authored by the same authenticated agent account, only use the existing
  comment's `node_id`, and never minimize human comments or comments from other
  bots. Use:
  `gh api graphql -f query='mutation MinimizeInlineReviewComment($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } } }' -F id='<comment_node_id>'`
- do not delete inline comments
- do not reply to, resolve, or minimize anything when authorship, PR ownership,
  supersession, or resolution confidence is uncertain
- summarize any inline comments posted, replies added, comments minimized, or
  threads resolved in the final synthesis `Progress` section
- do not post the full synthesis, a top-level summary, or a separate overall PR
  comment with `gh`; the workflow posts the final synthesis itself
- if needed, use `gh pr view ${PR_NUMBER} --repo ${GITHUB_REPOSITORY} --json files,headRefOid` and
  `gh api --paginate repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments`
  to compare against existing feedback before posting
- post new inline comments with this command shape:
  `gh api --method POST repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments -f body='<comment>' -f commit_id='<headRefOid>' -f path='<path>' -F line=<line> -f side=RIGHT`

Produce a unified review synthesis:
1. Deduplicate overlapping findings and note meaningful reviewer disagreements
2. Prioritize BLOCKING > WARNING > INFO, and preserve each disposition
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

| Issue | Severity | Disposition | Description |
| -- | -- | -- | -- |
| ... | BLOCKING/WARNING/INFO | FIX_IN_PR/HUMAN_DECISION/FOLLOW_UP | 1-2 sentences max |

Use only the allowed pairs: `BLOCKING|WARNING` with `FIX_IN_PR|HUMAN_DECISION`,
or `INFO` with `FOLLOW_UP`.

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
  - `FIX_PR`: unresolved `FIX_IN_PR` findings require one bounded automated fix.
  - `HUMAN_DECISION`: a required judgment must precede dependent branch changes.
  - `NO_AUTOMATED_ACTION`: no unresolved in-PR work remains; follow-ups may exist.
- Include one sentence explaining why. Never select `FIX_PR` for `FOLLOW_UP`
  findings alone, and select `HUMAN_DECISION` when that decision must precede a
  fix.

## Final Verdict
- `SHIP`, `MINOR_ISSUES`, or `NEEDS_REWORK`

## Action Items
- Include only unresolved `FIX_IN_PR` work, using the literal form
  `- [ ] FIX_IN_PR: <bounded task>`.
- Do not include `FOLLOW_UP` or `HUMAN_DECISION` items as checkboxes.

If no `FIX_IN_PR` or `HUMAN_DECISION` findings remain, set Recommended Next Step
to `NO_AUTOMATED_ACTION`. `FOLLOW_UP` findings alone must not produce
`NEEDS_REWORK`.

Do not include a preamble.
