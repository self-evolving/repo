# Project planning model

Sepo's GitHub Project is the planning source of truth for the
setup/project-management workstream. Issues and pull requests remain the work
items, while Sepo execution still starts from explicit mentions, one-shot
trigger labels, or orchestrator handoffs.

## Project fields

Use this minimal Project field model before adding more planning dimensions:

| Field | Required | Values |
|---|---:|---|
| `Status` | Yes | `Inbox`, `In Progress`, `To Review`, `Done` |
| `Priority` | Yes | `P0`, `P1`, `P2`, `P3` |
| `Effort` | Yes | `Low`, `Medium`, `High` |
| `Release` | No | Repository-defined release or roadmap target |

Do not add Project fields for agent route, executor, or agent state by default.
Active Sepo work is visible through labels and workflow state instead.

## Repository labels

Default repository labels should stay minimal and operational:

- `agent`: optional fixed status label for handled issues and pull requests.
- `agent/*`: one-shot trigger labels such as `agent/implement`,
  `agent/review`, `agent/fix-pr`, and `agent/orchestrate`.
- `agent-running/*`: temporary activity labels such as
  `agent-running/implement`, `agent-running/review`,
  `agent-running/fix-pr`, and `agent-running/orchestrate`.

`priority/*` and `effort/*` labels are legacy/fallback signals for repositories
that still use label-first project management. They are opt-in and should not be
the default planning surface when a GitHub Project is configured.

## Setup issue template

Use `.github/ISSUE_TEMPLATE/sepo-setup.yml` to capture setup intent in a
structured, human-editable issue before enabling Project-backed planning. The
template records the agent handle, assign-to-agent preference,
project-management mode, create-or-link Project choice, Project owner/title,
the default `Status` values, `Priority` and `Effort` field choices, and the
optional `Release` field choice.

Opening a setup issue is declarative only: it does not create GitHub Projects,
mutate repository variables, or enable project-management writes. Users should
ask for `@sepo-agent /setup plan` first and review the proposed changes.
`@sepo-agent /setup apply` is a later explicit confirmation step; the current
automation boundary below still defers the `/setup` route and deterministic
apply behavior to later work.

## Current automation boundary

Project-backed project management is experimental. Configure the planning
surface with `AGENT_PROJECT_MANAGEMENT_PROJECT_ID` and/or
`AGENT_PROJECT_MANAGEMENT_PROJECT_URL`; manual workflow runs can override those
values with the separate `project_id` and `project_url` inputs. The ID should be
a GitHub Project node ID with no whitespace. The URL should be an org or user
GitHub Project URL such as `https://github.com/orgs/OWNER/projects/1`.

The existing `agent-project-manager.yml` workflow is still a prompt-driven
summary plus legacy/fallback label-planning pass. It passes the configured
Project target to the agent as context, but it does not create GitHub Projects,
update Project fields, dispatch work from Project field changes, or mutate
repository variables. If no Project target is configured, the workflow keeps its
current summary/dry-run behavior. Until a dedicated Project sync exists, use its
summary as advisory for Project-backed planning and enable label writes only for
repositories that explicitly choose the legacy/fallback label mode.

Accepted Sepo work is still best-effort assigned to the login derived from
`AGENT_HANDLE`, and labels or mentions remain the automation signal layer.
