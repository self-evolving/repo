import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = join(__dirname, "../../..");

test("agent update request renderer fills the workflow prompt template", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-update-request-"));
  const outputFile = join(tempDir, "outputs.txt");
  const result = spawnSync("bash", [".agent/scripts/render-agent-update-request.sh"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputFile,
      SOURCE_KIND: "latest-release",
      SOURCE_REF: "v0.2.0",
      SOURCE_REPO: "self-evolving/repo",
      SOURCE_SHA: "abc123release",
      TARGET_DEFAULT_BRANCH: "main",
      TARGET_REPOSITORY: "example/repo",
      UPDATE_AGENT_MD: "false",
      UPDATE_BRANCH_PREFIX: "agent/update-agent-infra-",
      UPDATE_SKILLS: "true",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const outputText = readFileSync(outputFile, "utf8");
  assert.match(outputText, /request_text<</);
  assert.match(outputText, /target repository: example\/repo/);
  assert.match(outputText, /source agent repo\/ref: self-evolving\/repo@v0\.2\.0/);
  assert.match(outputText, /source agent SHA: abc123release/);
  assert.match(outputText, /Update Sepo from <installed version\/ref> to v0\.2\.0\/abc123release/);
  assert.doesNotMatch(outputText, /\{\{SOURCE_REF\}\}/);
});
