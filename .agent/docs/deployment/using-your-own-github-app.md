# Using your own GitHub App

Use this path when you want a fully self-managed or self-hosted setup. Create your own GitHub App and configure:

- `AGENT_APP_ID`
- `AGENT_APP_PRIVATE_KEY`

With this path, workflow authentication is resolved locally through your own GitHub App installation rather than being exchanged through the official hosted OIDC broker.

## Minimum app permissions

For the current workflow set, the app should have at least:

- **Contents**: read and write
- **Pull requests**: read and write
- **Issues**: read and write
- **Discussions**: read and write if you use discussion triggers
- **Actions**: read and write if you use approval dispatch, review artifacts, or related workflow-driven follow-up flows

## Installation bootstrap

The official hosted Sepo App can listen for GitHub App installation events and
try to dispatch `Agent / Onboarding / Check Setup` in the installed repository.
A self-managed App can use the same pattern from its webhook service:

1. verify the GitHub webhook signature
2. mint an installation token for the target repository
3. set `GH_TOKEN` to that token
4. run `node .agent/dist/cli/installation-bootstrap.js` with:
   - `GITHUB_REPOSITORY`, for example `owner/repo`
   - `DEFAULT_BRANCH`, for example `main`
   - `INSTALLATION_ID`, for logging/status text

The bootstrap CLI checks for `.github/workflows/agent-onboarding.yml` on the
default branch and dispatches it when present. If the workflow is missing or
dispatch fails, it creates or updates one `Sepo setup check` issue with manual
next steps instead of creating duplicates.

The App installation path cannot configure repository Actions secrets. Repository
owners still need to add `OPENAI_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` before
agent-backed routes can run.

Using your own app is the supported way to avoid depending on the official Sepo-hosted auth broker while keeping the same workflow behavior.

For the full auth priority and comparison against the hosted broker path, PAT fallback, and workflow token fallback, see [Setup guide](setup-guide.md).
