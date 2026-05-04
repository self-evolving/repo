# Sepo Versioning

Sepo uses SemVer for public version identity.

## Version Policy

- Use `v0.x.y` tags while the public install, update, and bug-report contract is still pre-release.
- Bump the `0.x` minor version for meaningful agent or workflow behavior changes before the public contract is stable.
- Bump the `0.x` patch version for bugfix-only releases.
- Use `v1.0.0-rc.N` only for true release candidates after the public contract is frozen.
- Use `v1.0.0` for the first public stable release.

The version string stored in metadata omits the leading `v` so it stays valid SemVer and matches package metadata. Git tags and release refs include the leading `v`, for example `v0.1.0`.

## Installed Metadata

Every Sepo install includes `.agent/sepo-version.json`:

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

Field semantics:

| Field | Meaning |
|---|---|
| `schema_version` | Metadata schema version, currently `1`. |
| `version` | Sepo SemVer string without a leading `v`. |
| `channel` | `pre-release`, `release-candidate`, or `stable`. |
| `source_repo` | GitHub `owner/repo` slug for the Sepo source used by the install. |
| `source_ref` | Source branch, tag, or ref used by the install. Release installs should use a tag such as `v0.1.0`. |
| `source_sha` | Exact source commit SHA when known. Moving-branch source checkouts may leave this as `null`; release installs should record it. |
| `installed_from` | Install source kind: `source`, `release`, `template`, `manual-copy`, or `update`. |
| `agent_files_hash` | Optional `sha256:<hex>` digest for the installed agent-owned files. `null` means no digest has been recorded yet. |

This separates the user-facing version from exact source identity. A fork or template copy can say which Sepo version line it started from even if later commits diverge. A release install should also record the exact tag commit and, when install tooling computes it, the installed file hash.

## CLI

After `.agent/dist` is built, workflows and diagnostics can read the installed identity with:

```bash
node .agent/dist/cli/print-sepo-version.js --json
```

The CLI validates `.agent/sepo-version.json`, prints either a compact summary or JSON, and writes GitHub Actions outputs for `version`, `channel`, `source_repo`, `source_ref`, `source_sha`, `installed_from`, `agent_files_hash`, and `summary`.
