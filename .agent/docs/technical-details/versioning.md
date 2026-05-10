# Sepo Versioning

Sepo uses SemVer for public version labels.

`.agent/package.json` is the canonical Sepo package/runtime version. Other
metadata may mirror that version for install diagnostics, but it must not become
a second independent version authority.

## Policy

- Use `v0.x.y` tags while the install, update, and bug-report contract is still pre-release.
- Bump the `0.x` minor version for meaningful agent or workflow changes.
- Bump the `0.x` patch version for bugfix-only releases.
- Use `v1.0.0-rc.N` only when the public contract is frozen and the release is truly a candidate for `v1.0.0`.
- Use `v1.0.0` for the first public stable release.

Package and metadata versions omit the leading `v` so they remain plain SemVer
and can stay aligned with `.agent/package.json`. Git tags and release refs
include the leading `v`, for example `v0.1.0`.

## Release Flow

Release preparation automation is intentionally GitHub Actions-only, not a
public slash route. The prepare workflow is hard-gated to `self-evolving/repo`
so forks and installed repositories do not accidentally prepare upstream Sepo
releases.

Prepare:

- Run `Agent / Release / Prepare` manually from GitHub Actions.
- Optionally provide a SemVer `version`; if omitted, the release agent determines
  the next version from `.agent/package.json`, recent changes, and this policy.
- The workflow creates or reuses a release preparation issue, then dispatches the
  existing implementation workflow with the release prompt.
- The release prompt may update files and open a PR, but must not create git
  tags, GitHub Releases, or package publications.

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
| `version` | Mirrored Sepo SemVer string without a leading `v`; `.agent/package.json` is canonical. |
| `channel` | `pre-release`, `release-candidate`, or `stable`. |
| `source_repo` | GitHub `owner/repo` slug used as the Sepo source. |
| `source_ref` | Branch, tag, or ref used by the install. Release installs should use a tag such as `v0.1.0`. |
| `source_sha` | Exact source commit SHA when known; use `null` for moving-branch installs until tooling records an exact SHA. |
| `installed_from` | `source`, `release`, `template`, `manual-copy`, or `update`. |
| `agent_files_hash` | Optional `sha256:<hex>` digest for installed agent-owned files; `null` means no digest has been recorded yet. |

This separates the user-facing Sepo version from the exact source identity. A fork or copied install can keep saying which Sepo line it started from while later tooling can add the exact commit and file hash when available.

Future update or bug-report workflows can add a small reader/CLI when they need
to consume this metadata directly.
