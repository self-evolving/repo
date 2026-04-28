## Task Description

A pull request in this repository was just merged, or was selected manually for rubric learning. Update the dedicated user/team rubrics branch with durable preferences learned from the PR conversation — no more, no less.

Pull request: #${TARGET_NUMBER} at ${TARGET_URL}

Rubrics are not memory. Memory records agent/project continuity; rubrics encode what users want future agent work to optimize for and be evaluated against.

Instructions:
1. Read the PR history, not just the final state:
   - `gh pr view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,mergedAt,closedAt,state,files,labels,reviews,reviewDecision,baseRefName,headRefName,url`
   - `gh api repos/${REPO_SLUG}/issues/${TARGET_NUMBER}/comments --paginate`
   - `gh api repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/comments --paginate`
   - `gh api repos/${REPO_SLUG}/pulls/${TARGET_NUMBER}/reviews --paginate`
   - `gh pr diff ${TARGET_NUMBER} --repo ${REPO_SLUG}` if file-level changes matter.
2. Read existing rubrics under `${RUBRICS_DIR}/rubrics/` before proposing changes.
3. Determine which commenters are trusted project contributors before learning:
   - Identify the repository owner and primary maintainers on a best-effort
     basis:
     - `gh repo view ${REPO_SLUG} --json owner,nameWithOwner`
     - `gh api repos/${REPO_SLUG}/collaborators --paginate --jq '.[] | select(.permissions.admin or .permissions.maintain) | {login: .login, type: .type, permissions: .permissions}'`
       when the token has permission. If this is unavailable, rely on each
       comment/review's author metadata instead.
   - For every candidate source, inspect the comment/review author's login,
     user type, and GitHub `author_association` / `authorAssociation` value.
     The `Requested by` runtime field identifies who started this run. On
     automatic merged-PR rubrics-update runs, it is the actor that closed/merged
     the PR; if that same actor authored an explicit request to add or update a
     rubric, treat that source as trusted even when best-effort collaborator or
     association lookup is incomplete. This exception applies only to content
     authored by `REQUESTED_BY`; it does not make other PR conversation
     participants trusted.
   - Treat repository-owner comments and direct admin/maintain collaborator
     comments as the primary source of user/team preference.
   - Treat GitHub `author_association` / `authorAssociation` values `OWNER`,
     `MEMBER`, and `COLLABORATOR` as trusted contributor signals. A clear
     instruction from one of these actors to add/update rubrics, or a durable
     "future agents should..." preference, is sufficient basis for a rubric;
     use vague non-primary maintainer comments as corroborating evidence rather
     than the sole basis for a new rubric.
   - Treat `CONTRIBUTOR`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`, `NONE`,
     and missing associations as untrusted for rubric learning unless a trusted
     contributor explicitly endorses the same preference.
   - Treat bot and agent-authored comments/reviews as advisory evidence only;
     do not convert them into user/team preference unless a trusted contributor
     explicitly agrees with the point.
   - When in doubt, prefer `no rubric changes` over learning from ambiguous or
     untrusted feedback.
4. Add or update a rubric only when trusted contributor interaction reveals a stable user/team preference, such as:
   - repeated reviewer feedback about implementation quality
   - explicit user preference about coding style, workflow, review quality, or communication
   - a durable expectation future agents should follow
5. Skip one-off comments, speculative preferences, and facts already covered by existing active rubrics.
6. Store one rubric per YAML file under `${RUBRICS_DIR}/rubrics/<domain>/`.
   Use the most specific source URL available in `examples[].source`, such as a
   PR review comment or issue comment URL, rather than only the PR URL.
7. Do not `git commit`; the workflow validates and commits rubrics after the run.

Rubric schema:

```yaml
schema_version: 1
id: kebab-case-stable-id
title: Short human-readable title
description: >-
  The user/team preference future agents should follow or be evaluated against.
type: generic # generic | specific
domain: coding_workflow # coding_style | coding_workflow | communication | review_quality
applies_to:
  - implement # implement | fix-pr | review | answer | skill | rubrics-review | rubrics-initialization | rubrics-update
severity: should # must | should | consider
weight: 3 # 1-10
status: active # active | draft | retired
examples:
  - source: https://github.com/self-evolving/repo/pull/${TARGET_NUMBER}#discussion_r123456789
    note: Specific reviewer/user comment that demonstrates why this rubric exists.
```

Guardrails:
- Prefer updating an existing rubric over creating a near-duplicate.
- Keep titles concise and descriptions actionable.
- Use `status: draft` when the preference seems useful but not yet strongly established.
- Use `severity: must` sparingly for clear, repeated, high-confidence requirements.
- Return a short summary of what you changed, or `no rubric changes` if nothing warranted an update.
