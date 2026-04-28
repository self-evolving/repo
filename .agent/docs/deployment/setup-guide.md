# Setup guide

There are two main customization points: how GitHub authentication is resolved, and where the workflows run.

## Supported GitHub auth paths

| Path | Best when | What you configure |
|---|---|---|
| Official Sepo-hosted app via OIDC broker | You want the easiest default setup | standard workflow permissions plus your model-provider secrets |
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

This path is built in and works without extra repository configuration beyond standard workflow permissions and model-provider secrets.

## Bring your own GitHub App

If you want a fully self-managed setup, configure:

- `AGENT_APP_ID`
- `AGENT_APP_PRIVATE_KEY`

The workflows then mint the installation token locally via `actions/create-github-app-token@v1`.

## Personal Access Token (PAT)

You can also configure `AGENT_PAT` as an escape hatch when app installation is blocked by policy or needed for debugging.

If you use a fine-grained PAT, start with these repository permissions:

- **Contents:** read and write
- **Pull requests:** read and write
- **Issues:** read and write
- **Discussions:** read and write, only if you use discussion triggers
- **Actions:** read and write, for approval dispatch and review artifact flows

## Workflow token fallback

If no higher-priority auth mode is configured, the backend can still fall back to `github.token`. This is useful as a lowest-friction fallback, but it should not be treated as the preferred long-term setup for more advanced automation.

## Continuity note

If you move to sticky self-hosted runners, also review `AGENT_SESSION_BUNDLE_MODE`. That setting is manual; the backend does not switch it automatically just because a runner is self-hosted. See [Self-hosted GitHub Action runner](self-hosted-github-action-runner.md) for the runner side of that trade-off.
