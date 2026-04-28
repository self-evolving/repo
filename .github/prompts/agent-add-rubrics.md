## Task Description

The user asked to add or update user/team rubrics from this request.

User request:
${REQUEST_TEXT}

## Instructions

1. Read existing rubrics under `${RUBRICS_DIR}/rubrics/` before editing.
2. Convert the request into durable, schema-valid rubric updates when warranted.
3. Prefer updating an existing rubric over creating a near-duplicate.
4. Keep changes limited to rubric YAML files unless a rubric README update is strictly needed.
5. If the request is ambiguous, unsafe, or one-off, make no rubric edits and explain why.
6. Do not run `git commit`; workflow post-processing validates and commits rubric edits.

Rubric schema:

```yaml
schema_version: 1
id: kebab-case-id
title: Short title
description: Durable preference future agents should follow
type: generic
domain: coding_style # coding_style | coding_workflow | communication | review_quality
applies_to:
  - implement # implement | fix-pr | review | answer | skill | rubrics-review | rubrics-initialization | rubrics-update
severity: should # must | should | consider
weight: 3 # 1-10
status: active # active | draft | retired
examples: []
```

Return a concise markdown summary of what changed, including rubric IDs touched, or `no rubric changes`.
