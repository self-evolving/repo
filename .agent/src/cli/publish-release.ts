// CLI: publish a Sepo release tag and GitHub Release.
// Env: GITHUB_REPOSITORY, VERSION, TARGET_REF, DRAFT, PRERELEASE, UPDATE_EXISTING

import { publishRelease } from "../release-publish.js";

try {
  const result = publishRelease({
    repo: process.env.GITHUB_REPOSITORY || "",
    version: process.env.VERSION || "",
    targetRef: process.env.TARGET_REF || "main",
    draft: process.env.DRAFT || "true",
    prerelease: process.env.PRERELEASE || "auto",
    updateExisting: process.env.UPDATE_EXISTING || "false",
  });

  console.log(
    `${result.releaseAction} ${result.tag} at ${result.targetSha} (${result.releaseUrl || "release URL unavailable"})`,
  );
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
