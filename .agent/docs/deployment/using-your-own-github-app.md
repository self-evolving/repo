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

Using your own app is the supported way to avoid depending on the official Sepo-hosted auth broker while keeping the same workflow behavior.

For the full auth priority and comparison against the hosted broker path, PAT fallback, and workflow token fallback, see [Setup guide](setup-guide.md).
