# Sepo Versioning

Sepo uses SemVer for public version labels.

## Policy

- Use `v0.x.y` tags while the install, update, and bug-report contract is still pre-release.
- Bump the `0.x` minor version for meaningful agent or workflow changes.
- Bump the `0.x` patch version for bugfix-only releases.
- Use `v1.0.0-rc.N` only when the public contract is frozen and the release is truly a candidate for `v1.0.0`.
- Use `v1.0.0` for the first public stable release.

The metadata version omits the leading `v` so it remains plain SemVer and can stay aligned with `.agent/package.json`. Git tags and release refs include the leading `v`, for example `v0.1.0`.

## Installed metadata

Every Sepo install carries `.agent/sepo-version.json`:

```json
{
  "schema_version": 1,
  "version": "0.1.0",
  "channel": "pre-release",
  "source_repo": "self-evolving/repo",
  "source_ref": "main",
  "source_sha": null,
  "installed_from": "source",
  "agent_files_hash": null
}
```

Fields:

| Field | Meaning |
|---|---|
| `schema_version` | Metadata schema version, currently `1`. |
| `version` | Sepo SemVer string without a leading `v`. |
| `channel` | `pre-release`, `release-candidate`, or `stable`. |
| `source_repo` | GitHub `owner/repo` slug used as the Sepo source. |
| `source_ref` | Branch, tag, or ref used by the install. Release installs should use a tag such as `v0.1.0`; values must be git-ref-like and cannot include whitespace, control characters, or invalid ref punctuation. |
| `source_sha` | Exact lowercase source commit SHA when known; use `null` for moving-branch installs until tooling records an exact SHA. |
| `installed_from` | `source`, `release`, `template`, `manual-copy`, or `update`. |
| `agent_files_hash` | Optional `sha256:<hex>` digest for installed agent-owned files; `null` means no digest has been recorded yet. |

This separates the user-facing Sepo version from the exact source identity. A fork or copied install can keep saying which Sepo line it started from while later tooling can add the exact commit and file hash when available.

## CLI

After `.agent/dist` is built, workflows and diagnostics can read the installed identity with:

```bash
node .agent/dist/cli/print-sepo-version.js --json
```

The CLI validates `.agent/sepo-version.json`, prints either JSON or a compact summary, and writes GitHub Actions outputs for `schema_version`, `version`, `channel`, `source_repo`, `source_ref`, `source_sha`, `installed_from`, `agent_files_hash`, and `summary`. Use `--path <metadata-json>` to validate a metadata file outside the installed `.agent/` tree.
