---
title: "Setup guide"
---

There are two main customization points: how GitHub authentication is resolved, and where the workflows run.

## Supported GitHub auth paths

| Path | Best when | What you configure |
|---|---|---|
| Official Sepo-hosted app via OIDC broker | You want the easiest default setup | standard workflow permissions, selected-repository Sepo GitHub App installation, and your model-provider secrets |
| Bring your own GitHub App | You want the supported self-managed path | `AGENT_APP_ID` + `AGENT_APP_PRIVATE_KEY` |
| Fine-grained PAT | App installation is blocked or you need a debugging escape hatch | `AGENT_PAT` |
| Fallback workflow token | Emergency or lowest-friction fallback | no extra secret; uses `github.token` |

The shared action `.github/actions/resolve-github-auth` handles all four modes through a single entry point and selects them in priority order, so workflows can keep one auth path even when repositories choose different credential strategies:

### Auth priority

1. direct GitHub App token from `AGENT_APP_ID` + `AGENT_APP_PRIVATE_KEY`
2. official OIDC broker exchange
3. `AGENT_PAT`
4. fallback workflow token `github.token`

## Comparing agent setups

- **Official hosted app via OIDC broker:** the least setup, but authentication is brokered through the official hosted exchange. That means the workflow sends an auth exchange request to a public Sepo service, similar to how the [Claude Code action](https://github.com/anthropics/claude-code-action) handles user requests.
- **Bring your own GitHub App:** the best supported self-managed path; it avoids the hosted broker and gives cleaner app-based identity, but requires app setup and installation management.
- **Fine-grained PAT:** a convenient fallback, but actions are attributed to the token owner and there is less separation between human and agent identity.
- **Fallback workflow token:** the weakest long-term option for automation patterns such as agent handoffs or broader follow-up flows.

## Official hosted app

The public hosted app is [sepo-agent-app](https://github.com/apps/sepo-agent-app),
owned by [self-evolving](https://github.com/self-evolving). Its GitHub App ID
is `3527007`.

In `.github/actions/resolve-github-auth`, the hosted app path:

- requests a GitHub Actions OIDC token
- exchanges it with the official Sepo broker
- receives a short-lived GitHub App installation token

This path is built in. It requires standard workflow permissions, the Sepo GitHub
App installed on the selected repository, and at least one model-provider secret.
Hosted users do not need repo-local `AGENT_APP_ID` / `AGENT_APP_PRIVATE_KEY`
secrets; those are only for the self-managed app path.

For first-time setup, install the Sepo GitHub App with **Only select repositories**
and select the repository you are onboarding. **All repositories** is supported,
but it grants broader access and can trigger bootstrap checks across many
repositories, so it is not the recommended first install path.

See [Developer notes](../technical-details/developer-notes.md#known-limitations)
for the hosted app installation limitation.

## Bring your own GitHub App

If you want a fully self-managed setup, configure:

- `AGENT_APP_ID`
- `AGENT_APP_PRIVATE_KEY`

The workflows then mint the installation token locally via `actions/create-github-app-token@v1`.

## Personal Access Token (PAT)

You can also configure `AGENT_PAT` as an escape hatch when app installation is blocked by policy or needed for debugging.

Public install requests use a separate install credential in the Sepo source
repository, so normal route authentication is unchanged. Most target repositories
do not need to configure that credential themselves. Operators of a Sepo source
repository can find internal credential details in [Developer notes](../technical-details/developer-notes.md#internal-install-route-credential).

If you use a fine-grained PAT, start with these repository permissions:

- **Contents:** read and write
- **Pull requests:** read and write
- **Issues:** read and write
- **Discussions:** read and write, only if you use discussion triggers
- **Actions:** read and write, for approval dispatch and review artifact flows

## Optional secondary external-repo token

Set `AGENT_SECONDARY_GITHUB_TOKEN` as a repository secret only when a
non-install agent run needs explicit access to repositories outside the current
Sepo repository. Bundled non-install workflows pass this secret to the agent as
`INPUT_SECONDARY_GITHUB_TOKEN`; it is additive and does not replace the primary
`GH_TOKEN`, `GITHUB_TOKEN`, or `INPUT_GITHUB_TOKEN` used for same-repository
comments, labels, workflow dispatches, memory, and rubrics.

Use a fine-grained PAT scoped only to the intended external repositories and
grant read access only to the needed surfaces, such as metadata, contents,
issues, pull requests, and discussions. The bundled secondary-token contract is
read-only external inspection; do not configure it as a write-capable external
credential. External writes need a route-specific credential and a deterministic
write authorization guard documented and tested with that route.

Private or otherwise non-public external repository read access is still
sensitive. If `AGENT_SECONDARY_GITHUB_TOKEN` can read those repositories, allow
only trusted requesters to trigger routes that receive it, tighten
`AGENT_ACCESS_POLICY` for those routes, or avoid granting private repository
scopes to the token.

The public `/install` route is separate: it continues to use the dedicated
install-only primary token described in developer notes. `AGENT_SECONDARY_GITHUB_TOKEN`
is a read-only secondary credential for explicit agent opt-in, not the install
replacement token.

## Progress comments and cancellation

No extra setup is required for the default live progress control. Implementation
and PR-fix workflows already have the comment and Actions permissions needed to
post one progress comment, update it during the run, merge the final status into
that comment, and honor an authorized 👎 reaction as a cancellation request.
Answer runs on issue and pull request surfaces use report-only progress by
default and merge the final answer into the same comment. Orchestrated chains
use handoff or status comments by default, and can opt into non-cancellable
progress comments with `AGENT_PROGRESS_POLICY.orchestration_mode`.

Set `AGENT_PROGRESS_POLICY` only when you want to change that default. Use
`report-only` for progress without cancellation, or `disabled` to turn progress
comments off for a route. For orchestrated runs, only
`"orchestration_mode":"report-only"` opts into progress comments; regular route
overrides remain ignored while orchestration is active.

## Workflow token fallback

If no higher-priority auth mode is configured, the backend can still fall back to `github.token`. This is useful as a lowest-friction fallback, but it should not be treated as the preferred long-term setup for more advanced automation.

## Continuity note

If you move to sticky self-hosted runners, also review `AGENT_SESSION_BUNDLE_MODE`. That setting is manual; the backend does not switch it automatically just because a runner is self-hosted. See [Self-hosted GitHub Action runner](self-hosted-github-action-runner.md) for the runner side of that trade-off.
