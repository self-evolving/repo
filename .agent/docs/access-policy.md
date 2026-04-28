# Trigger access policy

`AGENT_ACCESS_POLICY` is an optional repository variable that controls which GitHub author associations can trigger the agent.

## Policy shape

Use `allowed_associations` as the default allowlist for routes without a more specific rule:

```json
{
  "allowed_associations": ["OWNER", "MEMBER", "COLLABORATOR"]
}
```

Add `route_overrides` only when a route needs a narrower or wider allowlist than the default:

```json
{
  "allowed_associations": ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
  "route_overrides": {
    "implement": ["OWNER", "MEMBER"]
  }
}
```

Both keys are optional:

- `allowed_associations`: fallback allowlist for routes without an override
- `route_overrides`: map of route name to route-specific allowlist

Route override keys are matched after route resolution, so future routes can use the same policy shape without changing this schema. If a route has no override, it uses `allowed_associations`; if `allowed_associations` is also unset, it uses the repository visibility default below.

## Example

This policy lets contributors ask questions through the default `answer` behavior, while keeping implementation work limited to owners and organization members:

```json
{
  "allowed_associations": ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"],
  "route_overrides": {
    "implement": ["OWNER", "MEMBER"]
  }
}
```

## GitHub author associations

The values match GitHub's [`CommentAuthorAssociation`](https://docs.github.com/graphql/reference/enums#commentauthorassociation) enum:

- `OWNER`
- `MEMBER`
- `COLLABORATOR`
- `CONTRIBUTOR`
- `FIRST_TIME_CONTRIBUTOR`
- `FIRST_TIMER`
- `MANNEQUIN`
- `NONE`

## Default behavior

If `AGENT_ACCESS_POLICY` is unset:

- private repositories allow `OWNER`, `MEMBER`, `COLLABORATOR`, and `CONTRIBUTOR`
- public repositories also allow `OWNER`, `MEMBER`, `COLLABORATOR`, and `CONTRIBUTOR`

Known limitation: GitHub can report private organization members as `CONTRIBUTOR` in public repository issue payloads when the token or payload cannot see private membership. Sepo therefore includes `CONTRIBUTOR` in the public default allowlist as a pragmatic compatibility choice. Repositories that need stricter public access should set `AGENT_ACCESS_POLICY`, for example `{"allowed_associations":["OWNER","MEMBER","COLLABORATOR"]}`.

## Enforcement model

For mention and label triggers, trigger extraction validates the event, resolves explicit routes or labels when present, and records the caller association. Route authorization happens during dispatch resolution after explicit routes are normalized locally or implicit mentions are triaged into a concrete route.

That means `route_overrides` also apply to plain implicit mentions such as `@sepo-agent can you help?`. If the resolved route is not allowed, the router posts an inline unsupported reply instead of silently dropping the request.

Approval comments use the same policy after the pending request is found. The approval check uses the route stored in the pending request marker.

Label triggers authorize the label applier rather than the issue or pull request author. Personal-repository owners map to `OWNER`; visible organization members map to `MEMBER`; repository collaborators with label permission map to `COLLABORATOR`. After a label-triggered request is accepted by the router, `agent-label.yml` removes the triggering `agent/*` label even when the route is denied, so unauthorized queue labels do not linger.

Organization membership detection depends on what the agent's GitHub token can see. With a repo-scoped installation token, only **public** org memberships are visible, so private org members who apply a label resolve as `COLLABORATOR` rather than `MEMBER`. Policies that restrict a route to `MEMBER` only (e.g. `route_overrides.implement: ["OWNER", "MEMBER"]`) may therefore reject private org members unless `COLLABORATOR` is also included.

## Issue-body association refresh

For issue-body mentions from `issues` events, the runtime refreshes `author_association` from the GitHub API before access decisions when the webhook payload reports a weaker value (for example `NONE` or `CONTRIBUTOR`). If the refreshed issue association is still weak, the runtime also checks the issue author with `GET /repos/{owner}/{repo}/collaborators/{username}` and treats a `204` response as `COLLABORATOR`. This covers some cases where repo-scoped tokens cannot see private org membership through `author_association`, but GitHub author association remains token- and visibility-dependent. The public default allowlist therefore still includes `CONTRIBUTOR` unless a repository configures a stricter `AGENT_ACCESS_POLICY`.
