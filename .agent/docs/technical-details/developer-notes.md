---
title: "Developer notes"
---

## Testing

Run the backend test suite with:

```bash
cd .agent
npm test
```

Session bundle tests cover:

- bundle mode parsing
- artifact naming
- provider session file discovery
- create and restore round trips
- checksum validation
- path escape rejection
- thread-state interactions

For manual continuity checks, use a disposable `HOME` or container. Do not delete files from your real `~/.codex` or `~/.claude`.

## Internal install route credential

The source repository's public `/install` route reads `AGENT_INSTALL_PAT` as an
install-only machine-user token. It must be able to create or reuse a fork of the
public target repository, push `agent/install-agent-infra`, and open or update
the install PR. Normal routes do not use this secret and keep the standard auth
resolver order.

## Known limitations

> [!NOTE]
> The hosted Sepo App path only works for repositories where the Sepo GitHub App
> is installed. If you use selected-repository installation, add each repository
> before onboarding it.

- Workflow-level GitHub token permissions are broader than route-level `acpx` permission modes.
- Slash routes are hardcoded to `/answer`, `/implement`, `/create-action`, `/fix-pr`, `/review`, `/orchestrate`, `/skill`, and `/install`.
- Mention parsing does not fully handle lazy blockquote continuations or multi-backtick inline code spans.
- Implementation approval uses comments, not reactions.
- The verify chain is a lightweight post-agent check, not a full CI substitute.
