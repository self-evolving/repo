# Developer notes

## Testing

Run the backend test suite with:

```bash
cd .agent
npm test
```

Session bundle tests cover:

- bundle mode parsing
- artifact naming
- provider session file discovery
- create and restore round trips
- checksum validation
- path escape rejection
- thread-state interactions

For manual continuity checks, use a disposable `HOME` or container. Do not delete files from your real `~/.codex` or `~/.claude`.

## Known limitations

- Workflow-level GitHub token permissions are broader than route-level `acpx` permission modes.
- `skill_root` is advertised on `agent-router.yml` but is not wired through yet.
- Built-in slash routes, trigger labels, dispatch prompt route options, and target-kind constraints are defined in `.agent/src/routes.ts`; `/skill` and `agent/s/<name>` remain dynamic skill shortcuts.
- Mention parsing does not fully handle lazy blockquote continuations or multi-backtick inline code spans.
- Implementation approval uses comments, not reactions.
- The verify chain is a lightweight post-agent check, not a full CI substitute.
