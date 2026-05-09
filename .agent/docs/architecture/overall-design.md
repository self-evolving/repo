# Overall design

The `.agent` backend exposes a small set of GitHub-native agent workflows. Agent execution goes through the direct `acpx <agent> exec/prompt` path, with session continuity handled by `SessionPolicy` plus git-ref thread state.

## Triggering modes

- **User initiated**
  - mentions in issues, PRs, discussions, and comments
  - labels such as `agent/answer` or `agent/s/<skill>`
- **Workflow initiated**
  - downstream reusable workflows dispatched by the router after route resolution or approval
- **Scheduled or autonomous actions**
  - TODO

Approval comments such as `@sepo-agent /approve <request_id>` are part of the implementation lifecycle rather than a separate top-level trigger mode. See [The life cycle of an agent request](request-lifecycle.md) for that path.

## Portal flow

The first half of the portal flow decides whether the trigger should run at all and, if so, which route it should take.

```mermaid
flowchart LR
    trigger["@sepo-agent mention or agent/* label"]
    gate{Bot or\nunauthorized?}
    mention{Live mention\nafter stripping\ncode/quotes?}
    react["React with 👀"]
    explicit{Explicit slash\nroute command?}
    triage["Dispatch triage\n(approve-all, medium effort)"]
    route{Route?}

    trigger --> gate
    gate -- yes --> skip(["Skip"])
    gate -- no --> mention
    mention -- no --> skip
    mention -- yes --> react --> explicit
    explicit -- yes --> route
    explicit -- no --> triage --> route
```
Once the route is resolved, the backend either answers inline, asks for approval, or dispatches a route-specific workflow.

```mermaid
flowchart LR
    route{Route?}

    answer_run["Answer agent\n(approve-all, high effort)"]
    post_answer["Post reply on\noriginal surface"]

    is_issue{Source is\nan issue?}
    post_approval_issue["Post approval request\non issue"]
    post_proposal["Post proposed issue\non original surface"]
    approve["User replies:\n@agent approve"]
    create_issue["Create issue from\napproved proposal"]
    dispatch_impl["Dispatch\nagent-implement.yml"]
    dispatch_fix["Dispatch\nagent-fix-pr.yml"]
    dispatch_review["Dispatch\nagent-review.yml"]
    react_thumbs["React with 👍"]

    route -- "answer / unsupported" --> answer_run --> post_answer
    route -- "implement" --> is_issue
    is_issue -- yes --> post_approval_issue --> approve --> dispatch_impl
    is_issue -- no --> post_proposal --> approve --> create_issue --> dispatch_impl
    route -- "fix-pr (PR only, not on edit)" --> dispatch_fix --> react_thumbs
    route -- "review (PR only, not on edit)" --> dispatch_review --> react_thumbs
```

## Structure

### TypeScript runtime (`.agent/src/`)

All shared modules live flat in `.agent/src/`. CLI entrypoints live in `.agent/src/cli/`. Tests live in `.agent/src/__tests__/`. Package metadata lives in `.agent/package.json` and `.agent/tsconfig.json`.

Long-lived [agent-owned memory](memory.md) and [user-owned rubrics](rubrics.md) are intentionally separate state surfaces: `agent/memory` captures agent/project continuity, while `agent/rubrics` captures normative user/team preferences used for implementation steering and review scoring.
