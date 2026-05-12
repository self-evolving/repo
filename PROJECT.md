# Project

## Context
- Sepo is the canonical public self-evolving repository agent runtime in `self-evolving/repo`.
- Public defaults use `@sepo-agent` and the `sepo-agent-app` GitHub App.

- Repository license is MIT.
- Current near-term priorities: hosted App install webhook and fresh install/onboarding/update smoke tests.
- Sepo v0.1.0 is the initial public prerelease; tag/release work landed May 11-12, 2026.
## Open Questions
- Should Sepo add inner/reportable timeouts in run.ts/runAcpx/acpx-adapter after the GitHub-step timeout first pass?
- Should hosted Sepo be the quick-start default while repo-local Actions remains first-class for control/auditability?
- Should Sepo add an opt-in self-improvement proposal workflow before any auto-orchestration?
- Should agent-self-approve be internal/orchestrator-only for v1 when AGENT_ALLOW_SELF_APPROVE enables it?
