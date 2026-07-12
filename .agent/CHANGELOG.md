# Changelog

## Unreleased

### Added

- The portal now posts the initial 👀 reaction as its first step, before checkout and runtime setup, via a dependency-free, bounded REST call on issue/PR bodies and issue, PR, and review comments, with boundary-aware handle matching mirroring the runtime validator; a successful early reaction suppresses the later resolved-identity reaction. Discussions, PR review bodies, and edited events keep the post-setup path.

### Fixed

- Bot-sender events (such as Sepo's own progress-comment edits) and non-`agent/*` label events now run in throwaway concurrency groups, so they can no longer evict a queued human-triggered run — previously any such event could silently cancel a pending mention on the same issue. Human mentions now key concurrency on the triggering comment, so mentions in different comments run concurrently. Write routes gained non-lossy `queue: max` locks: `agent-fix-pr.yml` carries a job-level per-PR group covering the `workflow_call` path where workflow-level concurrency is not applied, and the router's `install` and `skill` jobs serialize per source target now that entrypoint concurrency no longer provides that serialization.

### Changed

- Mentions without a slash command now route directly to the inline answer path by default instead of running model-backed dispatch triage; change-shaped answers end with a copyable follow-up command (such as `/implement` or `/fix-pr`) that the user can send explicitly. Set `AGENT_TRIAGE_MODE=agent` to restore route inference for uncommanded mentions. Explicit slash routes, `agent/*` labels, access policy, and unmentioned follow-up gating are unaffected.
- The entrypoint mention pre-filter now checks only the active trigger title, body, comment, or review text and skips bot-authored events before allocating a runner, eliminating no-op runs from quoted handles elsewhere in the payload or from the agent's own comments.

## 0.4.0 - 2026-06-26

### Added

- Direct implementation and PR-fix runs now publish one live progress comment, merge final responses into that comment where possible, and support authorized thumbs-down reactions to cancel cancellable runs.
- The new `/add-rubrics` route proposes user/team rubric changes through draft PRs against `agent/rubrics` while keeping the Sepo runtime on the trusted default-branch checkout.
- Agents can now download private GitHub user attachments on demand through the dedicated `download-github-attachment` CLI, with token lookup, safe filenames, timeouts, and size limits.
- Provider model defaults now ship as bundled `.agent/model-defaults.json` data that installs and updates with the Sepo runtime.
- Self-hosted local-runner setup can install a post-job cleanup hook that trims old diagnostics and stale `_work` checkouts.
- `.agent` now exposes lane-based test scripts for runtime, workflow/action, docs, and shell checks.

### Changed

- Ask Sepo and Install Sepo issue templates now use Markdown templates with command bodies instead of the previous install issue form.
- Rubrics review preflight now skips model work, artifacts, and PR comments when rubrics are unavailable or no active rubrics match.
- Progress reporting policy now has route-aware defaults, including report-only answer progress and disabled progress comments for orchestrated runs unless explicitly opted in.

### Fixed

- Claude ACPX runs with date-pinned `claude-*` model IDs now set `ANTHROPIC_MODEL` instead of passing unsupported ACP model flags, fixing resumed-session failures.
- Progress cancellation, progress finalization, step counting, and tool-title rendering are more robust across long-running agent tasks.
- GitHub attachment downloads keep timeout enforcement active through response body reads.

## 0.3.1 - 2026-06-04

### Fixed

- Codex ACPX runs now use the packaged Codex ACP adapter, normalize GPT-5 reasoning model IDs, avoid duplicate session model flags, and mirror OpenAI credentials into the ACPX Codex auth environment.
- Provider defaults and model display metadata now expose consistent Codex and Claude model choices while preserving policy overrides and explicit display opt-outs.
- Follow-up and answer routing now better distinguish answer-only discussion from authorized changes, preserve review context on resumed answers, and support targeted inline review replies.
- Hosted OIDC authentication now retries transient broker failures while keeping deterministic auth errors terminal.
- Onboarding setup check issues are now consistently labeled for agent tracking and stale cleanup.
- Packaged workflow guard coverage no longer assumes installed repositories keep Sepo's root README content.

## 0.3.0 - 2026-05-24

### Added

- First-class `/install` support with issue-backed install requests, target fork/branch helpers, source issue links, and guarded publish behavior.
- Repository goal issue templates and orchestrator guidance for goal-backed parent work.
- Read-only secondary GitHub token plumbing for explicit external repository inspection.
- Direct `ANTHROPIC_API_KEY` support for Claude-backed runs, configurable agent model policy, and display-model controls.
- Global `AGENT_ENABLED=false` pause guards across packaged Sepo agent workflows.

### Changed

- Sepo documentation now uses reader-oriented section roots, `_meta.json` navigation metadata, and the `setup/`, `usage/`, `customization/`, and `technical-details/` structure.
- Provider resolution now uses the JavaScript resolver action and clearer precedence across route, model-policy, default-provider, and auto-detected settings.
- Full self-governance approval flows can rely on trusted current-head status evidence when self-approval and self-merge are enabled together.
- Onboarding and install guidance now link directly to target repository workflows, secrets, App setup, and setup guides.

### Fixed

- Closed or merged PRs inferred from `/implement` context are kept as context instead of becoming invalid stacked bases.
- Self-approval PR inspection works with read-scoped GitHub tokens while preserving reviewed-head provenance checks.
- Generated docs index links and docs validation coverage now match the reorganized docs tree.
- Provider/model handling now preserves Anthropic Claude credential support and route provider precedence.

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
