# Agent memory

This branch stores durable context for Sepo agents. It is separate from `main` so memory updates do not mix with product code.

## Layout

- `PROJECT.md` holds slow-changing project context: goals, constraints, and open questions.
- `MEMORY.md` holds durable conventions and lessons the agent should carry forward.
- `daily/YYYY-MM-DD.md` holds append-only daily activity bullets.
- `github/<owner>/<repo>/*.json` mirrors repository issues, pull requests, and discussions for lookup.
- Mirrored artifacts can be cited in notes as backlink-style paths, for example `[[github/<owner>/<repo>/issue-1.json]]`.

These files are the starting structure. Agents may add other notes when that keeps durable context easier to use.

## Tools

Memory-related CLI tools live on the `main` branch under `.agent/dist/cli/memory/` after the agent package is built. Useful tools include:

- `search.js` for searching markdown and JSON memory files.
- `update.js` for adding, replacing, removing, or appending standard memory bullets.
