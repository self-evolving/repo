---
title: "Sepo versioning"
---

Sepo uses SemVer for public version labels.

`.agent/package.json` is the canonical Sepo package/runtime version.

`.agent/CHANGELOG.md` is the canonical Sepo changelog.

## Policy

- Use `v0.x.y` tags while the install, update, and bug-report contract is still pre-release.
- Bump the `0.x` minor version for meaningful agent or workflow changes.
- Bump the `0.x` patch version for bugfix-only releases.
- Use `v1.0.0-rc.N` only when the public contract is frozen and the release is truly a candidate for `v1.0.0`.
- Use `v1.0.0` for the first public stable release.

Package versions omit the leading `v` so they remain plain SemVer. Git tags and
release refs include the leading `v`, for example `v0.1.0`.

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
- The release prompt may update files, including `.agent/CHANGELOG.md`, and
  open a PR, but must not create git tags, GitHub Releases, or package
  publications.
