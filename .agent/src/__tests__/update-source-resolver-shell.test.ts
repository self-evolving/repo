import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { strict as assert } from "node:assert";

function runUpdateSourceResolver(
  mode: "latest-release" | "manual" | "no-release" | "release-error",
  extraEnv: Record<string, string> = {},
) {
  const tempDir = mkdtempSync(join(tmpdir(), "update-source-resolver-"));
  const binDir = join(tempDir, "bin");
  const outputFile = join(tempDir, "outputs.txt");
  const callLog = join(tempDir, "gh-calls.txt");
  const ghPath = join(binDir, "gh");
  mkdirSync(binDir);
  writeFileSync(callLog, "");
  writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' \"$*\" >> \"${GH_STUB_CALL_LOG}\"",
      "if [ \"${1:-}\" != \"api\" ]; then",
      "  echo \"unexpected gh invocation: $*\" >&2",
      "  exit 1",
      "fi",
      "case \"${GH_STUB_MODE}:${2:-}\" in",
      "  latest-release:repos/self-evolving/repo/releases?per_page=100)",
      "    printf '%s\\n' '[{\"tag_name\":\"v0.2.0\",\"html_url\":\"https://github.com/self-evolving/repo/releases/tag/v0.2.0\",\"draft\":false,\"prerelease\":false}]'",
      "    ;;",
      "  latest-release:repos/self-evolving/repo/commits/v0.2.0)",
      "    printf '%s\\n' '{\"sha\":\"abc123release\"}'",
      "    ;;",
      "  manual:repos/self-evolving/repo/commits/main)",
      "    printf '%s\\n' '{\"sha\":\"def456manual\"}'",
      "    ;;",
      "  no-release:repos/self-evolving/repo/releases?per_page=100)",
      "    printf '%s\\n' '[]'",
      "    ;;",
      "  no-release:repos/self-evolving/repo/commits/main)",
      "    printf '%s\\n' '{\"sha\":\"fed789fallback\"}'",
      "    ;;",
      "  release-error:repos/self-evolving/repo/releases?per_page=100)",
      "    echo \"server unavailable\" >&2",
      "    exit 1",
      "    ;;",
      "  *)",
      "    echo \"unexpected gh invocation for ${GH_STUB_MODE}: $*\" >&2",
      "    exit 1",
      "    ;;",
      "esac",
    ].join("\n") + "\n",
  );
  chmodSync(ghPath, 0o755);

  const result = spawnSync("bash", ["scripts/resolve-update-source.sh"], {
    cwd: process.cwd().endsWith(".agent") ? process.cwd() : join(process.cwd(), ".agent"),
    env: {
      ...process.env,
      DEFAULT_UPDATE_SOURCE_REF: "main",
      GH_STUB_CALL_LOG: callLog,
      GH_STUB_MODE: mode,
      GH_TOKEN: "test-token",
      GITHUB_OUTPUT: outputFile,
      PATH: `${binDir}:${process.env.PATH || ""}`,
      UPDATE_SOURCE_REPO: "self-evolving/repo",
      UPDATE_SOURCE_REF: "",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  const outputText = result.status === 0 ? readFileSync(outputFile, "utf8") : "";
  const calls = readFileSync(callLog, "utf8");
  const payload = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { calls, outputText, payload, result };
}

test("update source resolver defaults to the latest stable release tag", () => {
  const { calls, outputText, payload, result } = runUpdateSourceResolver("latest-release");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload.sourceRef, "v0.2.0");
  assert.equal(payload.sourceSha, "abc123release");
  assert.equal(payload.sourceKind, "latest-release");
  assert.equal(payload.fallback, false);
  assert.match(calls, /repos\/self-evolving\/repo\/releases\?per_page=100/);
  assert.match(calls, /repos\/self-evolving\/repo\/commits\/v0\.2\.0/);
  assert.match(outputText, /source_ref<<[\s\S]*v0\.2\.0/);
  assert.match(outputText, /source_sha<<[\s\S]*abc123release/);
});

test("update source resolver preserves manual source_ref overrides", () => {
  const { calls, payload, result } = runUpdateSourceResolver("manual", { UPDATE_SOURCE_REF: "main" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload.sourceRef, "main");
  assert.equal(payload.sourceSha, "def456manual");
  assert.equal(payload.sourceKind, "manual");
  assert.equal(payload.fallback, false);
  assert.doesNotMatch(calls, /releases/);
  assert.match(calls, /repos\/self-evolving\/repo\/commits\/main/);
});

test("update source resolver falls back to main when no release exists", () => {
  const { outputText, payload, result } = runUpdateSourceResolver("no-release");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload.sourceRef, "main");
  assert.equal(payload.sourceSha, "fed789fallback");
  assert.equal(payload.sourceKind, "fallback-main");
  assert.equal(payload.fallback, true);
  assert.match(payload.reason, /no stable Sepo release found; falling back to main/);
  assert.match(outputText, /fallback<<[\s\S]*true/);
  assert.match(outputText, /reason<<[\s\S]*no stable Sepo release found/);
});

test("update source resolver fails when release listing fails", () => {
  const { calls, payload, result } = runUpdateSourceResolver("release-error");

  assert.notEqual(result.status, 0);
  assert.equal(payload, null);
  assert.match(result.stderr, /could not list stable releases for self-evolving\/repo/);
  assert.match(calls, /repos\/self-evolving\/repo\/releases\?per_page=100/);
  assert.doesNotMatch(calls, /repos\/self-evolving\/repo\/commits\/main/);
});
