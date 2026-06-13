## Task Description

Propose user/team rubric updates for `${REPO_SLUG}`.

You are running in `${AGENT_CWD}`, a checkout based on the repository's
`agent/rubrics` branch. The Sepo runtime checkout is available at
`${AGENT_RUNTIME_DIR}` for helper commands such as validation.

The request that triggered this run:

```text
${REQUEST_TEXT}
```

## Instructions

1. Read existing rubrics under `rubrics/` before making changes.
2. Prefer updating an existing rubric when the request refines an existing
   preference. Add a new rubric only when no existing active rubric covers it.
3. Store one rubric per YAML file under `rubrics/<area>/`.
4. Keep rubrics concise, durable, and grounded in the user's request or linked
   issue/PR context. Skip one-off facts, project status, or preferences that are
   already covered.
5. Validate before finishing:

```bash
node "${AGENT_RUNTIME_DIR}/.agent/dist/cli/rubrics/validate.js" --dir .
```

6. Do not commit, push, create branches, create PRs, or edit files outside this
   rubrics checkout. The workflow will commit and open a proposal PR against
   `agent/rubrics`.

Return exactly one JSON object and nothing else:

```json
{
  "summary": "One short paragraph for the workflow logs and issue comment.",
  "commit_message": "Concise commit message under 72 characters.",
  "pr_title": "Concise pull request title under 72 characters.",
  "pr_body": "GitHub-flavored markdown pull request body."
}
```

Rules:
- `summary` should describe the rubric change and validation run.
- `commit_message` should describe the rubric update, for example
  `docs(rubrics): add concise workflow rubric`.
- `pr_title` should name the rubric preference, not the issue number alone.
- `pr_body` should explain the proposed rubric update and include a reference
  to the triggering target, such as `Refs #${TARGET_NUMBER}`.
- If no rubric change is warranted, leave `commit_message`, `pr_title`, and
  `pr_body` empty and explain why in `summary`.
