## Task Description

Propose user/team rubric updates from this request.

User request:
${REQUEST_TEXT}

## Instructions

1. Read existing rubrics under `${RUBRICS_DIR}/rubrics/` before editing.
2. Convert the request into durable, schema-valid rubric updates only when warranted.
3. Prefer updating an existing active rubric over creating a near-duplicate.
4. Keep edits limited to rubric YAML files unless a README update is strictly required.
5. If the request is ambiguous, unsafe, one-off, or already covered, make no rubric edits and explain why.
6. If `${RUBRICS_AVAILABLE}` is not `true`, make no edits and explain that `${RUBRICS_REF}` must be initialized first.
7. Do not run `git commit`; workflow post-processing validates changes and opens a proposal PR targeting `${RUBRICS_REF}`.

Rubric schema:

```yaml
schema_version: 1
id: kebab-case-id
title: Short title
description: Durable preference future agents should follow
type: generic
domain: coding_style # coding_style | coding_workflow | communication | review_quality
applies_to:
  - implement # answer | implement | add-rubrics | create-action | fix-pr | review | skill | rubrics-review | rubrics-initialization | rubrics-update
severity: should # must | should | consider
weight: 3 # 1-10
status: active # active | draft | retired
examples: []
```

Return exactly one JSON object and nothing else:

```json
{
  "summary": "One short paragraph describing rubric IDs touched, or why no rubric changes were made.",
  "commit_message": "Concise commit message under 72 characters.",
  "pr_title": "Concise pull request title under 72 characters.",
  "pr_body": "GitHub-flavored markdown pull request body."
}
```

Rules:
- Use `chore(rubrics): ...` for non-empty commit messages.
- The PR body should summarize the rubric preference and mention that the PR targets `${RUBRICS_REF}`.
- Do not include issue-closing text unless the request explicitly asks to close an issue.
