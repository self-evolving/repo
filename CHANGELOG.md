# Changelog

All notable changes to Sepo are documented in this file.

## 0.1.0 - 2026-05-11

### Added

- Initial Sepo agent runtime, workflows, and local runner tooling for GitHub-native answer, implement, review, fix-pr, orchestrator, skill, memory, and rubrics workflows.
- Access policy, approval, session continuity, memory synchronization, rubric selection, review synthesis, and threaded status-comment support for repository agent runs.
- Setup, deployment, customization, architecture, action, and technical-detail documentation under `.agent/docs/`, with public defaults for `@sepo-agent` and `sepo-agent-app`.
- Scheduled maintenance workflows for daily summaries, memory scans, branch cleanup, stale issue closure, and Sepo infrastructure updates.
- Source-repo-gated Sepo release preparation automation that keeps `.agent/package.json` as the canonical runtime package version and validates public version labels with SemVer.
- Update-agent adoption behavior for existing update PRs, keeping privileged scheduled workflow runtime code on the trusted default branch while editing the target PR branch.
