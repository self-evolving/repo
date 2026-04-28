# Session continuity

Persistent session continuity can optionally use GitHub Actions artifacts to carry local agent session files across runs. This is useful when the next run lands on a fresh machine and local `HOME` state is not sticky.

## Session bundle modes

The shared `run-agent-task` action accepts `session_bundle_mode`:

- `never`: disable bundle restore and backup
- `auto`: enable restore and backup only for routes that attempt session resume
- `always`: enable restore and backup for any persistent session policy

The shared action also accepts `session_bundle_retention_days` with a default of `30`.

## Session forks

The shared `run-agent-task` action accepts `session_fork_from_thread_key` as an optional source thread. When the destination thread has no restorable bundle, `session-restore.js` can restore the source thread's last bundle and expose its `acpxSessionId` as the seed for the new destination run. After the run, normal thread-state and artifact registration happen under the destination thread key, so future runs follow the destination history.

Fork precedence is intentionally conservative:

1. restore/resume the destination thread when it already has a bundle
2. otherwise, restore/resume `session_fork_from_thread_key` when provided and available, but only when the destination does not already have an `acpxSessionId`
3. otherwise, continue with a fresh destination session

If a destination bundle download fails, fork fallback is attempted only when the destination lacks a session identity; otherwise the runtime keeps the destination identity and lets normal best-effort resume handling decide whether to resume or fall back fresh. Successful fork restores are recorded as `bundle_restore_status=restored_from_fork` on the destination thread state.

This is artifact-backed session forking rather than provider-native cloning. The source and destination can still share the underlying ACP session id, but their uploaded artifacts diverge after the destination run. It is therefore most reliable on fresh runners or when session bundle persistence is enabled.

The first consumer is explicit `/implement`: `agent-router.yml` dispatches `agent-implement.yml` with a fork source pointing at the prior `answer/default` thread for the original target. If the router creates a new tracking issue for a PR or discussion request, the fork source still points at the original PR/discussion thread, not the new issue.

### A detailed walkthrough of how the answer to implement fork works?

```mermaid
flowchart TD
    answer_request["User asks @agent /answer<br/>on an issue, PR, or discussion"]
    answer_run["Answer route runs<br/><code>repo:target:number:answer:default</code>"]
    answer_bundle["Answer run uploads a session bundle<br/>and stores artifact metadata in answer thread state"]

    implement_request["Later user asks @agent /implement<br/>on the same original target"]
    router["agent-router dispatches agent-implement.yml<br/><code>SESSION_FORK_FROM_THREAD_KEY = repo:target:number:answer:default</code>"]
    implement_thread["Implement destination thread<br/><code>repo:issue:number:implement:default</code>"]

    has_dest_bundle{"Destination has<br/>a restorable bundle?"}
    dest_identity{"Destination already has<br/><code>acpxSessionId</code>?"}
    has_answer_bundle{"Answer fork source has<br/>bundle + session id?"}

    restore_dest["Restore destination bundle<br/>and resume destination session"]
    keep_dest_identity["Do not restore fork files<br/>runtime keeps destination identity"]
    restore_answer["Restore answer bundle<br/>seed implement from answer session id"]
    fresh["Start a fresh implement session"]
    finish["After implement run<br/>write implement thread state<br/>upload implement bundle"]

    answer_request --> answer_run --> answer_bundle
    implement_request --> router --> implement_thread --> has_dest_bundle
    answer_bundle -. "source thread metadata" .-> router
    has_dest_bundle -- yes --> restore_dest --> finish
    has_dest_bundle -- no --> dest_identity
    dest_identity -- yes --> keep_dest_identity --> finish
    dest_identity -- no --> has_answer_bundle
    has_answer_bundle -- yes --> restore_answer --> finish
    has_answer_bundle -- no --> fresh --> finish
```

## Current repository behavior

- reusable workflows and direct route workflows fall back to repository variable `AGENT_SESSION_BUNDLE_MODE` before using the built-in `auto` default
- `fix-pr` uses `resume-best-effort` so repeated fix attempts resume when a session identity is available, but can start fresh instead of deadlocking when older thread state lacks an `acpxSessionId`
- self-hosted runners can choose to set `AGENT_SESSION_BUNDLE_MODE=never` to prefer local session state over artifact-backed continuity, but the backend does not switch this automatically

See [Self-hosted GitHub Action runner](../deployment/self-hosted-github-action-runner.md) for the runner side of that trade-off.

## Backed-up session files

When bundle persistence is enabled, the runtime backs up:

- acpx metadata:
  - `~/.acpx/sessions/<acpxRecordId>.json`
  - `~/.acpx/sessions/<acpxRecordId>.stream.ndjson`
- Codex provider state:
  - `~/.codex/sessions/**/*<acpxSessionId>*.jsonl`
- Claude provider state:
  - `~/.claude/projects/**/*<acpxSessionId>*.jsonl`

## Restore behavior

- restore is best-effort even when bundle mode is enabled
- the final continuity decision still comes from the route session policy in `run.ts`
- bundle restore bookkeeping does not create fresh thread state on a new thread
