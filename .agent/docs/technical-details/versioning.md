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

## Release flow

Release work is split into two phases:

1. Agent-assisted prepare: a maintainer runs `Agent / Release / Prepare` from
   GitHub Actions. The optional `version` input pins the exact version; when it
   is omitted, the agent chooses the next version from `.agent/package.json`,
   recent changes, and this policy, then explains the choice in the PR.
2. Manual publish: after the PR is merged, a maintainer runs
   `Agent / Release / Publish` from GitHub Actions in `self-evolving/repo`.

Prepare checklist:

- Validate the release version against the policy above.
- Update `.agent/package.json`.
- Update `.agent/package-lock.json` if package metadata changes require it.
- Update `.agent/sepo-version.json` only while it still carries a mirrored
  `version` field; `.agent/package.json` remains canonical.
- Update release notes, docs, or checklist content changed by the release.
- Do not create tags, GitHub Releases, or package publications during prepare.

Publish checklist:

- Run only from `self-evolving/repo`; the publish workflow is hard-gated to that
  repository so forks do not accidentally publish upstream releases.
- Verify `.agent/package.json` equals the requested version.
- Resolve the target commit SHA from the checked-out `target_ref`.
- Create annotated tag `vX.Y.Z` when it does not already exist.
- Create the GitHub Release when it does not already exist.
- Fail on an existing GitHub Release unless `update_existing=true` is set.

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
