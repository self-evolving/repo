# Project

## Context
- Sepo is the canonical public self-evolving repository agent runtime in `self-evolving/repo`.
- Public defaults use `@sepo-agent` and the `sepo-agent-app` GitHub App.

- Repository license is MIT.
- Current pre-v0.1 priorities: version/release identity (#177), release-tag updates (#116), hosted App install webhook, #75, and fresh install/onboarding/update smoke tests.
## Open Questions
- Should Sepo add inner/reportable timeouts in run.ts/runAcpx/acpx-adapter after the GitHub-step timeout first pass?
- Should hosted Sepo be the quick-start default while repo-local Actions remains first-class for control/auditability?
- Should Sepo add an opt-in self-improvement proposal workflow before any auto-orchestration?
- Should agent-self-approve be internal/orchestrator-only for v1 when AGENT_ALLOW_SELF_APPROVE enables it?
