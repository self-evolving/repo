import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = resolve(__dirname, "../../..");

function writeFakeGh(tempDir: string, body: string): void {
  writeFileSync(join(tempDir, "gh"), body, { encoding: "utf8", mode: 0o755 });
}

test("capture-pr-head CLI writes empty output when PR metadata lookup fails", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-capture-pr-head-"));

  try {
    const outputPath = join(tempDir, "github-output.txt");
    writeFileSync(outputPath, "", "utf8");
    writeFakeGh(
      tempDir,
      `#!/usr/bin/env bash
printf 'metadata unavailable\\n' >&2
exit 1
`,
    );

    const result = spawnSync("node", [".agent/dist/cli/capture-pr-head.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ""}`,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "self-evolving/repo",
        TARGET_NUMBER: "172",
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stderr, /Reviewed head capture skipped:/);
    assert.match(readFileSync(outputPath, "utf8"), /^head_sha<<DELIM_[0-9a-f]+\n\nDELIM_[0-9a-f]+$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
