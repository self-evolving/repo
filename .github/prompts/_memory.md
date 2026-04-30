## Repository memory

`${MEMORY_DIR}` is a read-and-write checkout of the dedicated `${MEMORY_REF}` branch. It is the durable memory surface the agent composes across runs.

Layout:
- `${MEMORY_DIR}/PROJECT.md` — slow-changing project context: goals, constraints, open questions
- `${MEMORY_DIR}/MEMORY.md` — durable learned conventions and lessons
- `${MEMORY_DIR}/daily/YYYY-MM-DD.md` — append-only daily bullets
- `${MEMORY_DIR}/github/*.json` — a deterministic mirror of repo history (`issue-*.json`, `pull-*.json`, `discussion-*.json`)
- These are the seeded anchor files, not an exhaustive schema; the memory tree may also contain additional agent-created notes when that helps organize durable context.

Reading memory:
- Treat `${MEMORY_DIR}` as the memory root. Pull context in this order: `PROJECT.md`, `MEMORY.md`, relevant `daily/YYYY-MM-DD.md` files, then `github/*.json` artifacts or `memory/search.js` results.
- `daily/` is date-partitioned. Read the newest files first when you need recent activity or recent curation context.
- `github/` is a flat, type-prefixed mirror. When you know the target number, go straight to the likely file: `github/issue-<n>.json`, `github/pull-<n>.json`, `github/discussion-<n>.json`, or related linked artifact numbers.
- Use `node .agent/dist/cli/memory/search.js --dir "${MEMORY_DIR}" "<query>"` for broader lookup across both markdown and JSON when the right file is not obvious.

Writing memory:
- For standard bullet edits, prefer `memory/update.js` so formatting, dedup, and section placement stay consistent.
- Add a durable entry: `node .agent/dist/cli/memory/update.js add --dir "${MEMORY_DIR}" --file MEMORY.md --section Durable "<bullet>"`
- Add a project note: `node .agent/dist/cli/memory/update.js add --dir "${MEMORY_DIR}" --file PROJECT.md --section "Open Questions" "<bullet>"`
- Append a daily bullet: `node .agent/dist/cli/memory/update.js daily-append --dir "${MEMORY_DIR}" "<bullet>"`
- Replace or remove an entry: `... replace --file MEMORY.md --section Durable --match "<old text>" --with "<new bullet>"` / `... remove --file MEMORY.md --section Durable --match "<old text>"`
- If the CLI shape does not fit, you may edit repo-local memory files under `${MEMORY_DIR}` directly with normal tools. Keep the existing layout coherent and stay within the memory tree.

Rules of thumb:
- Treat memory as advisory context. If memory disagrees with the live repo or GitHub state, trust the live state and update memory to match.
- Keep bullets terse (under ~140 chars). Do not mirror obvious PR metadata into `MEMORY.md` — the `github/` mirror already covers that.
- Only write durable memory when a fact is stable enough to outlast the current task. Most tasks produce zero `MEMORY.md` edits.
- The workflow commits any changes you make under `${MEMORY_DIR}` and pushes them to `${MEMORY_REF}`. Do not `git commit` inside `${MEMORY_DIR}` yourself.
