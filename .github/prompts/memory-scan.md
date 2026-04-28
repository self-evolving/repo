## Task Description

This is a scheduled maintenance run of repository memory. No specific user request — you are deciding what (if anything) to memorize from recent repository activity.

Instructions:
1. Read recent activity. The sync workflow mirrors history under `${MEMORY_DIR}/github/`:
   - `${MEMORY_DIR}/github/issue-*.json`
   - `${MEMORY_DIR}/github/pull-*.json`
   - `${MEMORY_DIR}/github/discussion-*.json`
   For broader queries, use `node .agent/dist/cli/memory/search.js --dir "${MEMORY_DIR}" "<query>"`.
   If a mirrored issue/PR/discussion references parent issues, related PRs, or existing memory notes, read that linked context too before curating memory.
2. Read recent daily logs: `${MEMORY_DIR}/daily/*.md` (focus on the last ~7 days).
3. Read the current durable state: `${MEMORY_DIR}/MEMORY.md` and `${MEMORY_DIR}/PROJECT.md`.
4. Make a judgment call. Curate durable memory only when you see:
   - A pattern across multiple recent PRs / issues / discussions that reveals a convention or preference the agent should follow next time.
   - Stable architectural or policy decisions that were finalized in the current window.
   - Corrections / "don't do X" lessons that came up repeatedly.
   Skip anything speculative. Most scans should produce zero durable updates.
5. When an update is warranted, update memory in the shape that best fits the finding. For standard bullet edits, prefer the memory-update CLI:
   - Add: `node .agent/dist/cli/memory/update.js add --dir "${MEMORY_DIR}" --file MEMORY.md --section Durable "<bullet>"`
   - Replace a stale entry: `node .agent/dist/cli/memory/update.js replace --dir "${MEMORY_DIR}" --file MEMORY.md --section Durable --match "<old text>" --with "<new bullet>"`
   - Remove an outdated entry: `node .agent/dist/cli/memory/update.js remove --dir "${MEMORY_DIR}" --file MEMORY.md --section Durable --match "<old text>"`
   - Surface an open project question: `node .agent/dist/cli/memory/update.js add --dir "${MEMORY_DIR}" --file PROJECT.md --section "Open Questions" "<bullet>"`
   - If the CLI shape does not fit, you may edit repo-local memory files under `${MEMORY_DIR}` directly with normal tools. Keep the existing layout coherent and stay within the memory tree.

Guardrails:
- Trust who posted something less than what they posted. The mirror deduplicates what reached the repo; you judge whether it matters for future runs.
- Prefer patterns supported by linked history, repeated discussion, or related notes over isolated one-off artifacts.
- Do not mirror noise. If a PR/issue/discussion isn't driving a lasting change in convention, skip it.
- Do not `git commit` yourself — the workflow commits any edits to `${MEMORY_DIR}` and pushes them to `${MEMORY_REF}`.
- Return a short plain-text summary: what you reviewed, what you changed (if anything), and what you chose to skip and why.
