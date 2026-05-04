## Task Description

The user requested a Sepo setup plan:

${MENTION_BODY}

## Setup Plan Scope

This route is plan-only. It must produce a proposed setup diff and summary, and
it must not mutate repository variables, GitHub Projects, labels, assignees, or
repository files.

You may inspect current state with read-only commands, including:

- `gh issue view ${TARGET_NUMBER} --repo ${REPO_SLUG} --json title,body,author,comments,labels,state,url`
- `.github/ISSUE_TEMPLATE/sepo-setup.yml`
- `.agent/docs/architecture/project-planning.md`
- `gh variable list --repo ${REPO_SLUG}`

If a read-only inspection command is unavailable or denied, continue with an
explicit warning in the plan.

## Allowed Setup Intent

Focus only on setup intent from the structured Sepo setup issue:

- `AGENT_HANDLE`
- assign-to-agent behavior derived from the configured agent handle
- project-management mode: `off`, `dry-run`, or `project-backed`
- GitHub Project ID or URL when already configured or supplied in the issue
- GitHub Project owner and title
- Project `Status` values, defaulting to `Inbox`, `In Progress`, `To Review`, `Done`
- Project `Priority` values `P0`, `P1`, `P2`, `P3`
- Project `Effort` values `Low`, `Medium`, `High`
- optional `Release` field values

Do not propose arbitrary repository variables, arbitrary Project fields, custom
automation triggers, Project item sync, Project creation commands, or Project
field apply behavior.

## Mutation Boundary

Do not run write commands, including:

- `gh variable set`
- `gh project create`, `gh project edit`, `gh project field-create`, or `gh project item-*`
- `gh api --method POST`, `PATCH`, `PUT`, or `DELETE`
- direct comment posting, issue edits, label edits, assignee edits, commits, or pushes

`/setup apply` is not implemented in this route. If the request asks to apply,
explain that only `/setup plan` is available right now.

## Output

Return only the reply body as GitHub-flavored markdown. The workflow will post it
on the original issue.

Keep the response compact and structured:

1. Current setup signals inspected.
2. Proposed variable diff, with current value, proposed value, and reason.
3. Proposed GitHub Project plan, with create/link intent and fields.
4. Warnings or missing information.
5. Next step: review the plan; `/setup apply` is deferred until a later
   deterministic apply route exists.
