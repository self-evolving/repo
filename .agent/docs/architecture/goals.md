---
title: "Repository goals"
---

Sepo tracks large repository objectives as GitHub issues with the `agent-goal`
label. A goal issue is the canonical, reviewable object for a strategic
objective. It should describe the objective, rationale, success criteria,
current strategy, subgoals, and linked work.

Use the `Agent goal` issue form to create one. The form applies `agent-goal`
and requires Goal, Why, and Success criteria. The durable source of truth is the
issue body and GitHub issue history.

## Hierarchy

Goal work should stay in the same GitHub-native hierarchy Sepo already uses:

```text
goal issue
  -> sub-issues or subgoals
      -> concrete implementation issues
          -> pull requests
              -> orchestrator progress comments
```

Goal issues are for objectives, not direct code patches. When the next step is
small and self-contained, a goal issue can link to an existing concrete issue or
ask Sepo to create one. When the work is larger or has several workstreams,
decompose it into child issues and keep each child specific enough for normal
implementation, review, and fix-pr loops.

## Orchestration

Run `@sepo-agent /orchestrate` on an `agent-goal` issue when Sepo should plan
the next bounded step. In agent automation mode, the orchestrator may treat the
issue as a parent objective and use the internal `delegate_issue` decision to
create, reuse, or adopt one child issue. The child issue then runs the normal
orchestrator flow, and the parent goal receives visible progress comments when
the child reaches a terminal state.

The orchestrator should stop for human direction when success criteria are
unclear, the next child issue would require a product or research judgment that
is not captured in the goal, or the remaining work is only optional cleanup.
During parent planning and later reflection, the goal's success criteria are the
scope boundary: proposed children should explain how they advance the goal, and
Sepo should avoid continuing work that no longer matches that objective.

`agent-goal` is a repository-management label, not a route trigger. Do not use
an `agent/goal` label for v0: labels under `agent/` select agent routes, while
goals are context for planning and decomposition. A future `agent/goal` label
would need explicit route semantics before entering the trigger namespace.

## Memory

Repository memory may summarize active goals in `PROJECT.md` so future agent
runs have lightweight context. Memory is not canonical for goal state. Goal
changes should remain reviewable in GitHub issues, sub-issues, PRs, and
orchestrator comments.

## Self-improvement and experiments

For self-improvement or autoresearch work, use a goal issue to define the
purpose and constraints before creating experiment or implementation children.
Experiment children should record their configuration, evaluation skill or
command, metric, result comment, and promoted PR when applicable. Normal code
quality gates, self-approval, and self-merge still apply only to promoted code
PRs; the goal issue keeps the broader objective and stopping criteria visible.
Self-improvement proposals should link back to the goal they advance, so future
automation has an explicit objective rather than optimizing the repository in an
unbounded direction.
