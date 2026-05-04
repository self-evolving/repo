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

## Current automation boundary

The existing `agent-project-manager.yml` workflow is still a prompt-driven
summary plus legacy/fallback label-planning pass. It does not create GitHub
Projects, update Project fields, dispatch work from Project field changes, or
mutate repository variables. Until a dedicated Project sync exists, use its
summary as advisory for Project-backed planning and enable label writes only for
repositories that explicitly choose the legacy/fallback label mode.

Accepted Sepo work is still best-effort assigned to the login derived from
`AGENT_HANDLE`, and labels or mentions remain the automation signal layer.
