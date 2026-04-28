## Task Description

Initialize the dedicated user/team rubrics branch for this repository.

Rubrics are not memory. Memory records agent/project continuity; rubrics encode what users want future agent work to optimize for and be evaluated against.

The branch skeleton has already been created under `${RUBRICS_DIR}`. Your job is to populate initial rubric YAML files when there is enough trusted evidence.

Initialization context:

${REQUEST_TEXT}

Instructions:
1. Read existing rubrics under `${RUBRICS_DIR}/rubrics/` before making changes.
2. Use the initialization context above as the highest-priority direction. It may include links to PRs, issues, comments, design notes, or plain-language preferences.
3. If initialization context is empty or too sparse, inspect repository history for durable preferences:
   - `gh pr list --repo ${REPO_SLUG} --state merged --limit 20 --json number,title,body,author,mergedAt,labels,url`
   - for promising PRs, use `gh pr view`, issue comments, review comments, reviews, and diffs as needed
   - inspect recent issues only when they contain explicit agent-workflow or implementation-quality preferences
4. Determine trusted contributors before learning from conversation:
   - Identify the repository owner and primary maintainers on a best-effort
     basis:
     - `gh repo view ${REPO_SLUG} --json owner,nameWithOwner`
     - `gh api repos/${REPO_SLUG}/collaborators --paginate --jq '.[] | select(.permissions.admin or .permissions.maintain) | {login: .login, type: .type, permissions: .permissions}'`
       when the token has permission. If this is unavailable, rely on each
       comment/review's author metadata instead.
   - For every candidate source, inspect the comment/review author's login,
     user type, and GitHub `author_association` / `authorAssociation` value.
   - Treat repository-owner comments and direct admin/maintain collaborator
     comments as the primary source of user/team preference.
   - Treat GitHub `author_association` / `authorAssociation` values `OWNER`,
     `MEMBER`, and `COLLABORATOR` as trusted contributor signals, but use
     non-primary maintainer comments as corroborating evidence rather than the
     sole basis for a new rubric.
   - Treat `CONTRIBUTOR`, `FIRST_TIMER`, `FIRST_TIME_CONTRIBUTOR`, `NONE`,
     and missing associations as untrusted for rubric learning unless a trusted
     contributor explicitly endorses the same preference.
   - Treat bot and agent-authored comments/reviews as advisory evidence only;
     do not convert them into user/team preference unless a trusted contributor
     explicitly agrees with the point.
5. Add initial rubrics only when trusted evidence reveals a stable user/team preference, such as:
   - repeated reviewer feedback about implementation quality
   - explicit user preference about coding style, workflow, review quality, or communication
   - durable expectations future agents should follow
6. Skip one-off comments, speculative preferences, repository facts, and preferences already covered by existing active rubrics.
7. Store one rubric per YAML file under `${RUBRICS_DIR}/rubrics/<area>/`,
   such as `coding/`, `communication/`, or `workflow/`. Directory names are
   organizational; the schema `domain` field is the source of truth.
   Use the most specific source URL available in `examples[].source`, such as a
   PR review comment or issue comment URL, rather than only the PR URL.
8. Use `status: draft` when the preference seems useful but is not yet strongly established.
9. Do not `git commit`; the workflow validates and commits rubrics after the run.
10. If there is not enough trusted evidence, leave only the initialized skeleton and return `no initial rubric changes`.

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
  - source: https://github.com/self-evolving/repo/pull/123#discussion_r123456789
    note: Specific trusted reviewer/user comment that demonstrates why this rubric exists.
```

Return a short markdown summary of what you changed, including:
- created rubric IDs and file paths
- sources used
- any notable skipped or ambiguous evidence
