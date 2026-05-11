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
- inspect existing inline review comments with
  `gh api --paginate repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/comments`
  before recommending line-specific feedback
- inspect existing review threads with GraphQL `reviewThreads` before
  recommending a thread-resolution suggestion, for example:
  `gh api graphql -f query='query ReviewThreads($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved viewerCanResolve path line comments(first: 100) { nodes { id databaseId author { login } body } } } } } } }' -F owner='<owner>' -F repo='<repo>' -F number=${TARGET_NUMBER}`
  Use the thread node `id` as `existing_thread_id` when suggesting
  `resolve_existing_thread`.
- if a finding deserves line-specific feedback, include the exact `path`, `line`,
  and suggested comment body so the review synthesis agent can post it later
  with:
  `gh api --method POST repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/comments -f body='<comment>' -f commit_id='<headRefOid>' -f path='<path>' -F line=<line> -f side=RIGHT`
- You may include an optional `Inline Comment Suggestions` section using this
  shape when existing inline comments affect what synthesis should do:
  - `action`: `open_new`, `reply_existing`, `resolve_existing_thread`,
    `mark_existing_outdated`, or `no_action`
  - `path`, `line`
  - `finding`: concise issue context used for dedupe and rationale
  - `suggested_body`: exact postable comment text for synthesis to use if it
    acts on the suggestion
  - `existing_comment_id` for replies, GraphQL `existing_thread_id` for
    resolution when known, and `existing_comment_node_id` for minimization when
    known
  - `rationale`
  Cleanup suggestions are advisory. Suggest `resolve_existing_thread` only when
  the fetched thread appears same-agent, unresolved, viewer-resolvable, on this
  PR, and the issue appears addressed or superseded. Suggest
  `mark_existing_outdated` only for older same-agent inline comments that appear
  superseded when no appropriate resolvable review-thread path is known. Use
  `no_action` when authorship, PR ownership, supersession, or resolution
  confidence is uncertain.
  These are suggestions only; do not mutate GitHub from the reviewer lane.

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
