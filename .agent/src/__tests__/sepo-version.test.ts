import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { runPrintSepoVersionCli } from "../cli/print-sepo-version.js";
import {
  DEFAULT_SEPO_VERSION_METADATA_PATH,
  formatSepoVersionSummary,
  readSepoVersionMetadata,
  validateSepoVersionMetadata,
  type SepoVersionMetadata,
} from "../sepo-version.js";

const fullSha = "0123456789abcdef0123456789abcdef01234567";
const sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const agentFilesHash = `sha256:${sha256}`;

function validMetadata(overrides: Partial<SepoVersionMetadata> = {}): SepoVersionMetadata {
  return {
    schema_version: 1,
    version: "0.1.0",
    channel: "pre-release",
    source_repo: "self-evolving/repo",
    source_ref: "main",
    source_sha: null,
    installed_from: "source",
    agent_files_hash: null,
    ...overrides,
  };
}

function outputBuffer() {
  let text = "";
  return {
    write(chunk: string) {
      text += chunk;
    },
    read() {
      return text;
    },
  };
}

test("committed Sepo version metadata validates", () => {
  assert.deepEqual(readSepoVersionMetadata(DEFAULT_SEPO_VERSION_METADATA_PATH), validMetadata());
});

test("validateSepoVersionMetadata accepts release metadata with exact source identity", () => {
  assert.deepEqual(
    validateSepoVersionMetadata(
      validMetadata({
        version: "1.0.0",
        channel: "stable",
        source_ref: "v1.0.0",
        source_sha: fullSha,
        installed_from: "release",
        agent_files_hash: agentFilesHash,
      }),
    ),
    validMetadata({
      version: "1.0.0",
      channel: "stable",
      source_ref: "v1.0.0",
      source_sha: fullSha,
      installed_from: "release",
      agent_files_hash: agentFilesHash,
    }),
  );
});

test("validateSepoVersionMetadata accepts null source_sha and agent_files_hash", () => {
  assert.deepEqual(
    validateSepoVersionMetadata(
      validMetadata({
        source_sha: null,
        agent_files_hash: null,
      }),
    ),
    validMetadata(),
  );
});

test("validateSepoVersionMetadata accepts git-ref-like source refs", () => {
  for (const sourceRef of [
    "main",
    "develop",
    "v0.1.0",
    "feature/version-metadata",
    "refs/tags/v0.1.0",
  ]) {
    assert.equal(
      validateSepoVersionMetadata(validMetadata({ source_ref: sourceRef })).source_ref,
      sourceRef,
    );
  }
});

test("validateSepoVersionMetadata rejects invalid source refs", () => {
  for (const sourceRef of [
    "feature branch",
    "feature\nbranch",
    "feature..branch",
    "feature//branch",
    "feature@{branch",
    "feature~branch",
    "feature^branch",
    "feature:branch",
    "feature?branch",
    "feature*branch",
    "feature[branch",
    "feature\\branch",
    "/feature",
    "feature/",
    "feature.",
    "feature/.branch",
    "feature/branch.lock",
    "@",
  ]) {
    assert.throws(
      () => validateSepoVersionMetadata(validMetadata({ source_ref: sourceRef })),
      /source_ref must be a git ref name without whitespace, control characters, or invalid syntax/,
      sourceRef,
    );
  }
});

test("validateSepoVersionMetadata rejects malformed schema fields", () => {
  assert.throws(
    () => validateSepoVersionMetadata({ ...validMetadata(), schema_version: 2 }),
    /schema_version must be 1/,
  );
  assert.throws(
    () => validateSepoVersionMetadata({ ...validMetadata(), extra: true }),
    /Unsupported Sepo version metadata field: extra/,
  );
  assert.throws(
    () => validateSepoVersionMetadata({ version: "0.1.0" }),
    /Missing required Sepo version metadata field: schema_version/,
  );
});

test("validateSepoVersionMetadata enforces version channel policy", () => {
  assert.throws(
    () => validateSepoVersionMetadata(validMetadata({ version: "v0.1.0" })),
    /version must be a SemVer string without a leading v/,
  );
  assert.throws(
    () => validateSepoVersionMetadata(validMetadata({ version: "1.0.0", channel: "pre-release" })),
    /pre-release channel versions must stay on the 0.x line/,
  );
  assert.throws(
    () =>
      validateSepoVersionMetadata(
        validMetadata({ version: "1.0.0-rc.0", channel: "release-candidate" }),
      ),
    /release-candidate channel must use 1.0.0-rc.N/,
  );
  assert.throws(
    () => validateSepoVersionMetadata(validMetadata({ version: "0.9.0", channel: "stable" })),
    /stable channel versions must be final 1.x or newer releases/,
  );
});

test("validateSepoVersionMetadata rejects partial or malformed source identity", () => {
  assert.throws(
    () => validateSepoVersionMetadata(validMetadata({ installed_from: "release" })),
    /release installs must record source_sha/,
  );
  assert.throws(
    () => validateSepoVersionMetadata(validMetadata({ source_repo: "self-evolving" })),
    /source_repo must be a GitHub owner\/repo slug/,
  );
  assert.throws(
    () => validateSepoVersionMetadata(validMetadata({ source_sha: "abc123" })),
    /source_sha must be null or a full lowercase Git commit SHA/,
  );
  assert.throws(
    () => validateSepoVersionMetadata(validMetadata({ source_sha: fullSha.toUpperCase() })),
    /source_sha must be null or a full lowercase Git commit SHA/,
  );
  assert.throws(
    () => validateSepoVersionMetadata(validMetadata({ agent_files_hash: "0123" })),
    /agent_files_hash must be null or sha256:<64 lowercase hex>/,
  );
});

test("formatSepoVersionSummary prints source identity fields", () => {
  assert.equal(
    formatSepoVersionSummary(
      validMetadata({ source_sha: fullSha, agent_files_hash: agentFilesHash }),
    ),
    `Sepo 0.1.0 channel=pre-release source=self-evolving/repo@main source_sha=0123456789ab installed_from=source agent_files_hash=${agentFilesHash}`,
  );
});

test("runPrintSepoVersionCli prints JSON and writes GitHub outputs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sepo-version-"));
  const metadataPath = join(tempDir, "sepo-version.json");
  const outputPath = join(tempDir, "github-output");
  const originalOutput = process.env.GITHUB_OUTPUT;
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  writeFileSync(metadataPath, `${JSON.stringify(validMetadata({ source_sha: fullSha }), null, 2)}\n`);
  process.env.GITHUB_OUTPUT = outputPath;

  try {
    const code = runPrintSepoVersionCli(["--path", metadataPath, "--json"], { stdout, stderr });

    assert.equal(code, 0);
    assert.equal(stderr.read(), "");
    assert.deepEqual(JSON.parse(stdout.read()), validMetadata({ source_sha: fullSha }));
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /schema_version<<.*\n1\n/s);
    assert.match(output, /version<<.*\n0\.1\.0\n/s);
    assert.match(output, /source_sha<<.*\n0123456789abcdef0123456789abcdef01234567\n/s);
    assert.match(output, /summary<<.*Sepo 0\.1\.0/s);
  } finally {
    if (originalOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = originalOutput;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runPrintSepoVersionCli fails clearly for invalid metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sepo-version-invalid-"));
  const metadataPath = join(tempDir, "sepo-version.json");
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  writeFileSync(metadataPath, '{"version":"0.1.0"}\n');

  try {
    const code = runPrintSepoVersionCli(["--path", metadataPath], { stdout, stderr });

    assert.equal(code, 1);
    assert.equal(stdout.read(), "");
    assert.match(stderr.read(), /Missing required Sepo version metadata field: schema_version/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
