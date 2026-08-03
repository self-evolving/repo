---
title: "Export local session traces"
---

Export a local transcript before sharing it with Sepo:

```bash
npm --prefix .agent run build
node .agent/dist/cli/export-local-session-trace.js \
  --input path/to/local-session.jsonl \
  --output local-session.sepo.json
```

Open and review `local-session.sepo.json` before attaching it anywhere. The exporter keeps only user and assistant text plus minimal provenance; it does not package a resumable provider session.

> [!IMPORTANT]
> Secret detection is defense in depth, not a guarantee. Review the exported file yourself and remove anything you do not intend to share. Never upload the original provider session, environment dump, or session-bundle archive as a substitute for the sanitized trace.

This foundation creates and validates the local trace format. GitHub comment/attachment verification and the inspection workflow are separate features and are not enabled by this CLI.

## Supported input

The exporter accepts UTF-8 files up to 25 MiB:

- canonical Sepo trace JSON or JSONL
- Codex and Claude JSONL session records, using a narrow allowlist of their user/assistant text message shapes
- generic JSON arrays or `{ "messages": [...] }` objects containing role/content messages
- Markdown with `## User` / `## Assistant` headings
- text with `User:` / `Assistant:` labels; `Human:` and `AI:` are aliases

An unlabeled Markdown or text file becomes one user message. Use `--input-format json|jsonl|markdown|text` when the filename or contents do not make the format clear. `--input -` reads standard input.

System, developer, reasoning, tool, function, attachment, environment, and file-snapshot records are discarded. Within text content, known environment/tool XML blocks and common credential forms are removed or replaced with `[REDACTED credential]`. Non-text content blocks are never copied.

Archive and binary inputs are rejected. Extract or convert a transcript locally first; the exporter never opens `.zip`, `.tgz`, `.tar`, or other archives.

## Role-labelled input

Markdown input can use headings:

```markdown
## User

Please explain the failing test.

## Assistant

The assertion expects the old field name.
```

Plain text can use labels:

```text
User: Please explain the failing test.
Assistant: The assertion expects the old field name.
```

`System:`, `Developer:`, `Tool:`, and `Function:` blocks act as discard boundaries, so their content is not appended to the preceding message. Role-like lines inside fenced Markdown code blocks remain ordinary message text.

## Canonical version 1 format

Canonical JSON uses a strict allowlist. Unknown fields are rejected instead of being silently carried into a shareable trace:

```json
{
  "kind": "sepo.local_session_trace",
  "schema_version": 1,
  "exported_at": "2026-08-03T12:34:56.000Z",
  "provenance": {
    "source_format": "jsonl",
    "provider": "codex"
  },
  "messages": [
    {
      "role": "user",
      "content": "Please explain the failing test.",
      "timestamp": "2026-08-03T12:30:00.000Z"
    },
    {
      "role": "assistant",
      "content": "The assertion expects the old field name."
    }
  ]
}
```

`provider` and per-message `timestamp` are optional. The exporter infers `codex` or `claude` from recognized native JSONL records, or you can set `--provider <name>`. A conflicting explicit and detected provider fails clearly.

Canonical JSONL contains one `trace` header followed by `message` records:

```jsonl
{"record_type":"trace","kind":"sepo.local_session_trace","schema_version":1,"exported_at":"2026-08-03T12:34:56.000Z","provenance":{"source_format":"text"}}
{"record_type":"message","role":"user","content":"Please explain the failing test."}
{"record_type":"message","role":"assistant","content":"The assertion expects the old field name."}
```

Select JSONL explicitly with `--output-format jsonl`, or use an output filename ending in `.jsonl` or `.ndjson`.

## Output safety

The source file is never modified. The CLI writes canonical JSON to standard output unless `--output` is set, refuses to use the input path as the output path, and will not replace an existing output file unless `--force` is provided.

Run `--help` for the complete option list:

```bash
node .agent/dist/cli/export-local-session-trace.js --help
```
