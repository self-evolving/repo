const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const RELEASE_VERSION_RE = new RegExp(
  `^v?(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?$`,
);

export interface ReleaseVersion {
  version: string;
  tag: string;
  major: number;
  minor: number;
  patch: number;
  prereleaseLabel: string;
}

export function parseReleaseVersion(value: string): ReleaseVersion {
  const raw = String(value || "").trim();
  const match = raw.match(RELEASE_VERSION_RE);
  if (!match) {
    throw new Error("version must be SemVer without build metadata, for example 0.2.0 or 1.0.0-rc.1");
  }

  const [, major, minor, patch, prereleaseLabel = ""] = match;
  const version = `${major}.${minor}.${patch}${prereleaseLabel ? `-${prereleaseLabel}` : ""}`;
  return {
    version,
    tag: `v${version}`,
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prereleaseLabel,
  };
}
