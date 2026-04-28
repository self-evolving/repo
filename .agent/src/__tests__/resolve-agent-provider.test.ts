import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = path.resolve(__dirname, "../../..");
const resolverScript = path.join(
  repoRoot,
  ".github/actions/resolve-agent-provider/resolve-provider.sh",
);

type ResolverEnv = Partial<Record<
  | "ROUTE"
  | "ROUTE_PROVIDER"
  | "DEFAULT_PROVIDER"
  | "OPENAI_API_KEY"
  | "CLAUDE_CODE_OAUTH_TOKEN"
  | "REQUIRED",
  string
>>;

function parseOutputs(outputFile: string): Record<string, string> {
  if (!existsSync(outputFile)) {
    return {};
  }

  return Object.fromEntries(
    readFileSync(outputFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1, `Expected GitHub output line with '=': ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function runResolver(env: ResolverEnv = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-provider-"));
  const outputFile = path.join(tempDir, "github-output");

  try {
    const result = spawnSync("bash", [resolverScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        ROUTE: "test-route",
        ROUTE_PROVIDER: "",
        DEFAULT_PROVIDER: "auto",
        OPENAI_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        REQUIRED: "true",
        ...env,
      },
    });

    return {
      ...result,
      outputs: parseOutputs(outputFile),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("provider resolver auto-detects configured providers deterministically", () => {
  const both = runResolver({
    OPENAI_API_KEY: "openai-token",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
  });

  assert.equal(both.status, 0, both.stderr);
  assert.equal(both.outputs.provider, "codex");
  assert.equal(both.outputs.reason, "OPENAI_API_KEY is configured");
  assert.equal(both.outputs.install_codex, "true");
  assert.equal(both.outputs.install_claude, "false");

  const claudeOnly = runResolver({ CLAUDE_CODE_OAUTH_TOKEN: "claude-token" });

  assert.equal(claudeOnly.status, 0, claudeOnly.stderr);
  assert.equal(claudeOnly.outputs.provider, "claude");
  assert.equal(claudeOnly.outputs.reason, "CLAUDE_CODE_OAUTH_TOKEN is configured");
  assert.equal(claudeOnly.outputs.install_codex, "false");
  assert.equal(claudeOnly.outputs.install_claude, "true");
});

test("provider resolver honors default and inline route overrides", () => {
  const defaultOverride = runResolver({
    DEFAULT_PROVIDER: " Claude ",
    OPENAI_API_KEY: "openai-token",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
  });

  assert.equal(defaultOverride.status, 0, defaultOverride.stderr);
  assert.equal(defaultOverride.outputs.provider, "claude");
  assert.equal(defaultOverride.outputs.reason, "AGENT_DEFAULT_PROVIDER");

  const routeOverride = runResolver({
    ROUTE_PROVIDER: "codex",
    DEFAULT_PROVIDER: "claude",
    OPENAI_API_KEY: "openai-token",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
  });

  assert.equal(routeOverride.status, 0, routeOverride.stderr);
  assert.equal(routeOverride.outputs.provider, "codex");
  assert.equal(routeOverride.outputs.reason, "route override for test-route");
});

test("provider resolver supports explicit providers without repository secrets", () => {
  const codex = runResolver({ DEFAULT_PROVIDER: "codex" });

  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.outputs.provider, "codex");
  assert.equal(codex.outputs.reason, "AGENT_DEFAULT_PROVIDER");
  assert.equal(codex.outputs.install_codex, "true");
  assert.equal(codex.outputs.install_claude, "false");
  assert.match(codex.stderr, /relying on local Codex authentication/);

  const claude = runResolver({ ROUTE_PROVIDER: "claude", DEFAULT_PROVIDER: "codex" });

  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(claude.outputs.provider, "claude");
  assert.equal(claude.outputs.reason, "route override for test-route");
  assert.equal(claude.outputs.install_codex, "false");
  assert.equal(claude.outputs.install_claude, "true");
  assert.match(claude.stderr, /relying on local Claude authentication/);
});

test("provider resolver supports nonfatal unresolved setup passes", () => {
  const soft = runResolver({ REQUIRED: "false" });

  assert.equal(soft.status, 0, soft.stderr);
  assert.equal(soft.outputs.provider, "");
  assert.equal(soft.outputs.reason, "no configured provider");
  assert.equal(soft.outputs.install_codex, "false");
  assert.equal(soft.outputs.install_claude, "false");
  assert.match(soft.stderr, /No configured agent provider/);
  assert.match(soft.stdout, /unresolved/);
});

test("provider resolver rejects invalid providers and required auto without readiness", () => {
  const invalid = runResolver({ DEFAULT_PROVIDER: "co dex", OPENAI_API_KEY: "openai-token" });

  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid agent provider 'co dex'/);

  const missingAuto = runResolver();

  assert.notEqual(missingAuto.status, 0);
  assert.match(missingAuto.stderr, /No configured agent provider/);
});
