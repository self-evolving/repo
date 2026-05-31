import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = path.resolve(__dirname, "../../..");
const restoreScript = path.join(
  repoRoot,
  ".github/actions/run-agent-task/restore-pi-auth.sh",
);

function runRestore(env: Record<string, string>) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "pi-auth-"));
  const githubEnv = path.join(tempDir, "github-env");

  const result = spawnSync("bash", [restoreScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: tempDir,
      HOME: tempDir,
      GITHUB_ENV: githubEnv,
      PI_AUTH_JSON: "",
      PI_AUTH_JSON_B64: "",
      ...env,
    },
  });

  return { result, tempDir, githubEnv };
}

test("restore-pi-auth restores literal auth json to isolated Pi dir", () => {
  const { result, tempDir, githubEnv } = runRestore({
    PI_AUTH_JSON: '{"accessToken":"test"}',
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(path.join(tempDir, "pi-agent", "auth.json"), "utf8"),
      '{"accessToken":"test"}',
    );
    assert.equal(statSync(path.join(tempDir, "pi-agent", "auth.json")).mode & 0o777, 0o600);
    assert.match(readFileSync(githubEnv, "utf8"), /^PI_CODING_AGENT_DIR=.*pi-agent$/m);
    assert.match(readFileSync(githubEnv, "utf8"), /^PI_CODING_AGENT_SESSION_DIR=.*\.pi\/agent\/sessions$/m);
    assert.match(readFileSync(githubEnv, "utf8"), /^PI_AUTH_RESTORED=true$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("restore-pi-auth restores base64 auth json", () => {
  const authJson = '{"refreshToken":"rotating"}';
  const { result, tempDir } = runRestore({
    PI_AUTH_JSON_B64: Buffer.from(authJson, "utf8").toString("base64"),
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(tempDir, "pi-agent", "auth.json"), "utf8"), authJson);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("restore-pi-auth fails when both auth json inputs are set", () => {
  const { result, tempDir } = runRestore({
    PI_AUTH_JSON: "{}",
    PI_AUTH_JSON_B64: Buffer.from("{}", "utf8").toString("base64"),
  });

  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configure only one Pi auth secret/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
