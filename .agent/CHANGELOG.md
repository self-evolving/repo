# Changelog

## 0.2.0 - 2026-05-19

### Added

- Opt-in self-approval and self-merge workflows with reviewed-head provenance, PR-author blocks, status comments, and orchestrator handoffs.
- Repository skill setup hooks through `setup.sh` and a shared skill setup action.
- Upload-only track-only session bundles for debugging one-shot runs without treating them as resumable continuity state.

### Changed

- Dispatch and orchestration now recognize orchestrate starts from triage, derive implement tracking metadata from issue context, and carry stacked `base_pr` metadata through router dispatch.
- Onboarding and installation docs now emphasize hosted App prerequisites, reused setup issue status, and simpler first-run guidance.
- Daily summary scheduling and orchestration defaults are more conservative; the packaged daily summary cron remains disabled by default.
- GitHub memory artifacts are namespaced by owner and repo, with legacy artifact cleanup kept explicit.
- Sepo release notes now live in `.agent/CHANGELOG.md` alongside the canonical runtime version in `.agent/package.json`.

### Fixed

- Normalized weak GitHub mention associations across triggers and added regression coverage for weak association handling.
- Hardened auto-merge eligibility, self-approval status upserts, and review handoff behavior for current reviewed heads.

## 0.1.0 - 2026-05-11

### Added

Initial public pre-release of Sepo, a GitHub-native agent harness for orchestrating long-running coding tasks with repository memory through GitHub Actions. It features the following:
- Git-native memory and rubrics layout: code-related memory and induced user/team rubrics live alongside the repository on the `agent/memory` and `agent/rubrics` branches.
- GitHub Actions workflows that can propose code changes, run verification, and execute computational experiments without requiring a separate always-on server.
- Agent orchestration for long-horizon tasks — including task breakdown, review/fix loops, and iterative self-improvement workflows.
