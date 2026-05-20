## Task Description

Interpret the user's natural-language request as a repository Actions variable configuration plan for `${REPO_SLUG}`.

Request:

${REQUEST_TEXT}

## Scope

Only plan changes to repository Actions variables that configure Sepo. Do not plan secrets, organization variables, environment variables, repository settings, branch protection, workflow file edits, or multi-repository changes.

Allowed variable names:

- `AGENT_HANDLE`
- `AGENT_RUNS_ON`
- `AGENT_DEFAULT_PROVIDER`
- `AGENT_SESSION_BUNDLE_MODE`
- `AGENT_AUTOMATION_MODE`
- `AGENT_AUTOMATION_MAX_ROUNDS`
- `AGENT_ALLOW_SELF_APPROVE`
- `AGENT_ALLOW_SELF_MERGE`
- `AGENT_COLLAPSE_OLD_REVIEWS`
- `AGENT_STATUS_LABEL_ENABLED`
- `AGENT_PROJECT_MANAGEMENT_ENABLED`
- `AGENT_PROJECT_MANAGEMENT_DRY_RUN`
- `AGENT_PROJECT_MANAGEMENT_APPLY_LABELS`
- `AGENT_PROJECT_MANAGEMENT_POST_SUMMARY`
- `AGENT_PROJECT_MANAGEMENT_DISCUSSION_CATEGORY`
- `AGENT_PROJECT_MANAGEMENT_LIMIT`
- `AGENT_AUTO_UPDATE`
- `AGENT_ACCESS_POLICY`
- `AGENT_TASK_TIMEOUT_POLICY`
- `AGENT_MEMORY_POLICY`
- `AGENT_MEMORY_REF`
- `AGENT_SCHEDULE_POLICY`
- `AGENT_RUBRICS_POLICY`
- `AGENT_RUBRICS_REF`
- `AGENT_RUBRICS_LIMIT`
- `AGENT_COMMITTER_NAME`
- `AGENT_COMMITTER_EMAIL`

## Rules

- Return a plan only for unambiguous requested changes.
- Use `set` for variables that should be created or updated.
- Use `unset` for variables that should be removed.
- Convert boolean-like requests to string values `"true"` or `"false"`.
- Preserve JSON policy values as compact JSON strings.
- If the request asks for secrets, non-Sepo variables, repository settings, multiple repositories, or anything ambiguous, return an empty `operations` array with a concise top-level `reason`.
- Do not call `gh variable`, `gh api`, or mutate anything. The workflow validates and applies the plan deterministically after your response.

## Final Output

Return exactly one JSON object and nothing else:

```json
{
  "reason": "",
  "operations": [
    {
      "action": "set",
      "name": "AGENT_AUTO_UPDATE",
      "value": "false",
      "reason": "Disable scheduled Sepo update checks"
    },
    {
      "action": "unset",
      "name": "AGENT_STATUS_LABEL_ENABLED",
      "reason": "Return status labeling to the built-in default"
    }
  ]
}
```
