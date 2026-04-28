## Task Description

Generate a concise daily report from recently synced GitHub activity.

The request text includes the summary date, lookback window, and the absolute path to a signals directory produced earlier in this workflow.

Read these signals first:
- `github-sync.json` — sync counts and cursor metadata
- `memory/github/*.json` — recently updated issues, pull requests, and discussions mirrored by the existing memory-sync code

Instructions:
1. If a signal file is missing or empty, treat that signal as unavailable.
2. Report only what is visible in the synced GitHub activity window; do not imply a complete repository-wide status scan.
3. Do not mutate files and do not call GitHub write APIs.
4. Keep the report concise, factual, and actionable.
5. Use GitHub-flavored markdown. Do not include a preamble.

Produce exactly these sections:

## Recent Activity

Summarize notable recently updated issues, pull requests, and discussions. If little changed, say so.

## Recently Active PRs

Mention only pull requests present in the synced signal files.

## Recently Active Issues

Mention only issues present in the synced signal files.

## Recently Active Discussions

Mention only discussions present in the synced signal files.

## Follow-ups

List 1-3 concrete next steps, or say there are no obvious follow-ups from the synced activity.
