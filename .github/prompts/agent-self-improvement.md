## Task Description

Run the Sepo self-improvement planning step for `${REPO_SLUG}`.

This is a planning-only run. Do not create issues, pull requests, branches,
commits, labels, comments, workflow dispatches, durable memory edits, or rubric
edits. The workflow will validate your final decision and perform the selected
GitHub write/dispatch action deterministically.

Runtime request/configuration:

${REQUEST_TEXT}

## Goal

Make exactly one liveness-first routing decision for the next self-improvement
step. Existing self-improvement issues, pull requests, and failed runs are
context, not locks. Do not assume an open proposal means the workflow should
stop; decide whether to continue it, continue an existing PR, or create a new
proposal.

## Required Research

Before deciding:

1. Inspect this repository's current state: recent issues, pull requests,
   workflow runs, failed runs, open PRs, and relevant agent workflow files.
2. Inspect recent self-improvement attempts, especially items containing or
   discussing `sepo-agent-self-improvement`, prior scheduled self-improvement
   proposal issues, and PRs linked from those issues.
3. If an existing issue or PR is clearly the best target to continue, choose it
   instead of creating a duplicate proposal.
4. If prior work is stale, wrong, failed for incidental reasons, or unrelated to
   the highest-leverage next step, create a new proposal issue and explain why.
5. Inspect `self-evolving/repo` for current Sepo direction when useful, and
   check related GitHub repositories or web-visible agent-harness patterns for
   inspiration. Treat external repositories as inspiration only; do not clone or
   execute external code.

## Decision Options

Return exactly one decision:

- `new_issue`: create a fresh self-improvement proposal issue, then dispatch the
  orchestrator on that issue.
- `continue_issue`: comment on an existing issue, then dispatch the orchestrator
  on that issue.
- `continue_pr`: comment on an existing pull request, then dispatch the
  orchestrator on that PR.

Prefer `continue_issue` or `continue_pr` when there is an obvious stuck or
active target whose continuation is more useful than a duplicate new proposal.
Prefer `new_issue` when the next improvement is distinct, the existing target is
not the best route, or the previous attempt failed in a way that is better
superseded by a fresh proposal.

## New Issue Proposal Guidance

For `new_issue`, the proposal should be concrete enough for the existing
`agent-orchestrator.yml` planner to implement or delegate. Keep it scoped to one
focused PR when possible.

Use one lane in the issue title and body when it fits:

- `function-advance`: new or improved agent capability or workflow behavior.
- `code-quality`: tests, reliability, maintainability, typed helper cleanup, or
  runtime correctness.
- `documentation-clarity`: docs, prompt clarity, setup guidance, or operational
  explanation.

Do not mix lanes in one proposal unless the proposal explicitly explains why a
small docs/test update is inseparable from the main runtime change.

## Final Output

Return only one JSON object, optionally wrapped in a fenced `json` code block.
Do not include prose outside the JSON object.

For `new_issue`:

```json
{
  "decision": "new_issue",
  "reason": "Why a fresh proposal is the best next route.",
  "issue_title": "code-quality: Concrete proposal title under 70 chars",
  "issue_body": "# code-quality: Concrete proposal title\n\n## Proposal\n...\n\n## Why This One\n...\n\n## Evidence\n...\n\n## Scope\n...\n\n## Suggested Orchestrator Handoff\n..."
}
```

For `continue_issue`:

```json
{
  "decision": "continue_issue",
  "target_number": 123,
  "reason": "Why this existing issue is the right continuation target.",
  "comment": "Short visible trace comment explaining what the scheduled self-improvement run is continuing."
}
```

For `continue_pr`:

```json
{
  "decision": "continue_pr",
  "target_number": 456,
  "reason": "Why this existing PR is the right continuation target.",
  "comment": "Short visible trace comment explaining what the scheduled self-improvement run is continuing."
}
```
