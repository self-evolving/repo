# Project

## Context
- Sepo is the canonical public self-evolving repository agent runtime in `self-evolving/repo`.
- Public defaults use `@sepo-agent` and the `sepo-agent-app` GitHub App.

- Repository license is MIT.
- Current near-term priorities: hosted App install webhook and fresh install/onboarding/update smoke tests.
- Sepo v0.5.0 is the current public release; published July 18, 2026. [[github/self-evolving/repo/pull-483.json]]
## Open Questions
- Should Sepo add inner/reportable timeouts in run.ts/runAcpx/acpx-adapter after the GitHub-step timeout first pass?
- Should hosted Sepo be the quick-start default while repo-local Actions remains first-class for control/auditability?
- Should Sepo add MCP server setup as runtime config instead of prompt text? [[github/self-evolving/repo/issue-450.json]]
