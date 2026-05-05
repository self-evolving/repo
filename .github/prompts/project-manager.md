## Task Description

Run the repository project-manager pass. Assess open issues and pull requests with agent judgment, emit a legacy/fallback managed triage-label change plan, and return the final summary for the workflow to publish.

Runtime request/configuration:

${REQUEST_TEXT}

## Minimal Project Planning Model

For Project-backed planning, the GitHub Project is the planning source of truth.
Use this minimal model:

- `Status`: `Inbox`, `In Progress`, `To Review`, `Done`
- `Priority`: `P0`, `P1`, `P2`, `P3`
- `Effort`: `Low`, `Medium`, `High`
- Optional `Release`

Default repository labels stay operational: `agent`, one-shot `agent/*` trigger
labels, and temporary `agent-running/*` activity labels. Do not use
`priority/*` or `effort/*` as the default Project-backed planning surface.

This prompt does not create or update GitHub Projects, Project fields,
repository variables, issues, pull requests, reviews, or discussion comments.
The current workflow only supports the legacy/fallback label plan below.

If the runtime request says no GitHub Project is configured, preserve the
current summary/dry-run behavior and do not imply that Project-backed planning
is active. If a GitHub Project ID, URL, owner, or title is configured, treat it
as an experimental planning target for context only. You may mention the
configured Project target in the summary, but do not call GitHub Project APIs or
claim that Project fields were read or updated.

## Legacy/Fallback Managed Labels

Use exactly these opt-in legacy/fallback managed label families for the
structured `label_changes` plan:

- Priority: `priority/p0`, `priority/p1`, `priority/p2`, `priority/p3`
- Effort: `effort/low`, `effort/medium`, `effort/high`

Recommended label colors/descriptions when creating missing labels:

| Label | Color | Description |
|---|---:|---|
| `priority/p0` | `b60205` | Legacy/fallback project management: P0 priority |
| `priority/p1` | `d93f0b` | Legacy/fallback project management: P1 priority |
| `priority/p2` | `fbca04` | Legacy/fallback project management: P2 priority |
| `priority/p3` | `c2e0c6` | Legacy/fallback project management: P3 priority |
| `effort/low` | `c2e0c6` | Legacy/fallback project management: low effort |
| `effort/medium` | `fbca04` | Legacy/fallback project management: medium effort |
| `effort/high` | `d73a4a` | Legacy/fallback project management: high effort |

Priority guidance:

- `priority/p0`: urgent or critical work, especially security, data loss, production breakage, broken releases, or work that blocks many other tasks.
- `priority/p1`: high-impact work that should be near the top of the queue, including important bugs, major user-facing regressions, or PRs/issues blocking active work.
- `priority/p2`: normal valuable work that should be tracked but is not immediately critical.
- `priority/p3`: low-impact, speculative, stale, informational, or nice-to-have work.

Effort guidance:

- `effort/low`: small, localized, review-only, documentation/copy, typo, or straightforward follow-up.
- `effort/medium`: normal implementation/review work with moderate scope or uncertainty.
- `effort/high`: broad, risky, cross-cutting, architectural, migration, security-sensitive, or multi-step work.

## Process

1. Determine the effective repository and limit from the runtime request. Default to `${REPO_SLUG}` and limit `100` per kind if unspecified.
2. List open issues and pull requests with `gh`:
   - `gh issue list --repo ${REPO_SLUG} --state open --limit <limit> --json number,title,body,labels,createdAt,updatedAt,comments,assignees`
   - `gh pr list --repo ${REPO_SLUG} --state open --limit <limit> --json number,title,body,labels,createdAt,updatedAt,comments,assignees,isDraft,reviewDecision`
3. Use judgment from titles, bodies, labels, recency, discussion volume, assignment, draft/review status, and repository context. Do not reduce the decision to keyword heuristics.
4. For this legacy/fallback label plan, assign each considered item exactly one managed priority label and exactly one managed effort label.
5. Compute planned label changes by removing stale managed priority/effort labels that do not match the chosen labels and adding missing chosen labels. Do not remove unrelated labels or operational `agent`, `agent/*`, or `agent-running/*` labels.
6. Do not mutate labels, even when label application is enabled. The workflow has a deterministic post-agent step that validates and applies only allowed managed-label operations.
7. Do not create labels, issues, pull requests, commits, branches, reviews, or discussion comments. The workflow has separate deterministic final steps for managed labels and summary publication.

## Final Output

Return only GitHub-flavored markdown. This response is the project-management summary that the workflow will pass to deterministic label application, write to the Actions step summary, and may post to the Daily Summary discussion.

Use this structure:

## Project Management Summary

- Mode: `dry run`, `labels applied`, or `labels not applied`
- Project target: `not configured` or the configured Project ID/URL/owner/title from runtime
- Open items assessed: `<issue count> issues, <pull request count> pull requests`
- Managed labels: legacy/fallback `priority/*`, `effort/*`

### Top Triage Queue

List the top 5-10 items sorted by your assessed priority and actionability. For each item include:

- `issue#N` or `pull_request#N`
- title
- selected priority and effort labels
- concise rationale
- applied or planned label changes

### Label Changes

Summarize applied changes, planned dry-run changes, or say no changes were needed.

Include the structured change plan in one fenced `json` block using exactly this shape:

```json
{
  "label_changes": [
    {
      "kind": "issue",
      "number": 123,
      "add": ["priority/p1", "effort/medium"],
      "remove": ["priority/p3"]
    },
    {
      "kind": "pull_request",
      "number": 456,
      "add": ["priority/p2"],
      "remove": []
    }
  ]
}
```

Use only `kind` values `issue` or `pull_request`. Use only managed labels in `add` and `remove`: `priority/p0`, `priority/p1`, `priority/p2`, `priority/p3`, `effort/low`, `effort/medium`, `effort/high`.

### Notes

Include any assumptions, skipped items, failures, or follow-ups. Keep this concise.
