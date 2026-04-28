## Task Description

Perform a thorough code review of this pull request.

Gather current PR context before judging the change:
- `gh pr view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,files,labels,reviews,reviewDecision,state,url`
- `gh pr view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json files,headRefOid`
- `gh pr diff ${TARGET_NUMBER} --repo ${REPO_SLUG}`
- use `git` and local file reads to inspect repository patterns and base-branch code

The checked-out repository reflects the PR base branch for workflow safety, so
treat the live PR diff as the source of truth for proposed changes.

This review phase must not mutate GitHub state:
- do not submit a PR review with `gh`
- do not post inline review comments
- do not post top-level PR comments
- return your review only as markdown in the final response
- if a finding deserves line-specific feedback, include the exact `path`, `line`,
  and suggested comment body so the review synthesis agent can post it later
  with:
  `gh api --method POST repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/comments -f body='<comment>' -f commit_id='<headRefOid>' -f path='<path>' -F line=<line> -f side=RIGHT`

Review in this order:

0. Understand the goal first. Identify the underlying problem, the ideal target state, and the most principled path to that target before drilling into details. Decide whether the PR is solving the right problem in the right way. Consider existing repository patterns first. If the prior review context has not already done it and the choice materially affects the judgment, search for relevant libraries, framework features, or platform guidance and note whether they offer a better-supported implementation.
1. Design critique: is the design easy to extend, and does it avoid rebuilding wheels badly when an existing repository pattern, library, or platform capability would be clearer?
2. Implementation quality: bugs, regressions, security or trust-boundary issues, performance problems, and hacky, brittle, or unnecessarily complex code or solutions.
3. Tests: are the risky parts covered by real, meaningful tests that exercise behavior rather than only shallow happy paths?
4. Documentation and workflow fit: are the docs, prompts, and workflow notes the most efficient way to communicate the change, and do workflow or automation changes make operational sense?

Categorize each finding as:
- **BLOCKING**
- **WARNING**
- **INFO**

End with:
1. An overall verdict: SHIP / MINOR_ISSUES / NEEDS_REWORK
2. A "Files to Review" section listing the most important changed files and why

Format as clean GitHub-flavored markdown.
