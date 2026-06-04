import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const repoRoot = path.resolve(__dirname, "../../..");
const resolverScript = path.join(
  repoRoot,
  ".github/actions/resolve-agent-provider/resolve-provider.js",
);

type ResolverEnv = Partial<Record<
  | "ROUTE"
  | "ROUTE_PROVIDER"
  | "DEFAULT_PROVIDER"
  | "OPENAI_API_KEY"
  | "CLAUDE_CODE_OAUTH_TOKEN"
  | "ANTHROPIC_API_KEY"
  | "REQUIRED"
  | "AGENT_MODEL_POLICY",
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
    const result = spawnSync(process.execPath, [resolverScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        ROUTE: "test-route",
        ROUTE_PROVIDER: "",
        DEFAULT_PROVIDER: "auto",
        OPENAI_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        REQUIRED: "true",
        AGENT_MODEL_POLICY: "",
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

  const anthropicOnly = runResolver({ ANTHROPIC_API_KEY: "anthropic-token" });

  assert.equal(anthropicOnly.status, 0, anthropicOnly.stderr);
  assert.equal(anthropicOnly.outputs.provider, "claude");
  assert.equal(anthropicOnly.outputs.reason, "ANTHROPIC_API_KEY is configured");
  assert.equal(anthropicOnly.outputs.install_codex, "false");
  assert.equal(anthropicOnly.outputs.install_claude, "true");

  const bothClaudeCredentials = runResolver({
    CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
    ANTHROPIC_API_KEY: "anthropic-token",
  });

  assert.equal(bothClaudeCredentials.status, 0, bothClaudeCredentials.stderr);
  assert.equal(bothClaudeCredentials.outputs.provider, "claude");
  assert.equal(
    bothClaudeCredentials.outputs.reason,
    "CLAUDE_CODE_OAUTH_TOKEN is configured",
  );
  assert.equal(bothClaudeCredentials.outputs.install_codex, "false");
  assert.equal(bothClaudeCredentials.outputs.install_claude, "true");
});

test("provider resolver loads bundled provider model defaults", () => {
  const codex = runResolver({
    DEFAULT_PROVIDER: "codex",
  });

  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.outputs.provider, "codex");
  assert.equal(codex.outputs.model, "gpt-5.5");
  assert.equal(codex.outputs.reasoning_effort, "");

  const claude = runResolver({
    DEFAULT_PROVIDER: "claude",
  });

  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(claude.outputs.provider, "claude");
  assert.equal(claude.outputs.model, "claude-opus-4-8");
  assert.equal(claude.outputs.reasoning_effort, "");
});

test("provider resolver fails when a bundled provider default is missing", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-provider-defaults-"));
  const outputFile = path.join(tempDir, "github-output");

  try {
    // Recreate the action directory layout so the resolver's relative
    // ../../../.agent/model-defaults.json path resolves inside the temp tree.
    const actionDir = path.join(tempDir, ".github/actions/resolve-agent-provider");
    mkdirSync(actionDir, { recursive: true });
    const scopedResolver = path.join(actionDir, "resolve-provider.js");
    copyFileSync(resolverScript, scopedResolver);

    mkdirSync(path.join(tempDir, ".agent"), { recursive: true });
    writeFileSync(
      path.join(tempDir, ".agent/model-defaults.json"),
      JSON.stringify({ providers: { codex: { default: { model: "gpt-5.5" } } } }),
    );

    const result = spawnSync(process.execPath, [scopedResolver], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        ROUTE: "test-route",
        ROUTE_PROVIDER: "",
        DEFAULT_PROVIDER: "claude",
        OPENAI_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        REQUIRED: "true",
        AGENT_MODEL_POLICY: "",
      },
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /providers\.claude\.default\.model/);
    assert.equal(parseOutputs(outputFile).model, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

test("provider resolver applies model policy defaults and provider settings", () => {
  const resolved = runResolver({
    DEFAULT_PROVIDER: "claude",
    AGENT_MODEL_POLICY: JSON.stringify({
      default: { model: "claude-default", reasoning_effort: "high" },
      providers: {
        claude: { reasoning_effort: "max" },
      },
    }),
  });

  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.outputs.provider, "claude");
  assert.equal(resolved.outputs.reason, "AGENT_DEFAULT_PROVIDER");
  assert.equal(resolved.outputs.model, "claude-default");
  assert.equal(resolved.outputs.reasoning_effort, "max");
  assert.match(resolved.stderr, /relying on local Claude authentication/);
});

test("provider resolver ignores display policy because display is handled by run-agent-task", () => {
  const policyDisplay = runResolver({
    OPENAI_API_KEY: "openai-token",
    AGENT_MODEL_POLICY: JSON.stringify({
      display: { enabled: true },
    }),
  });

  assert.equal(policyDisplay.status, 0, policyDisplay.stderr);
  assert.equal(policyDisplay.outputs.provider, "codex");
  assert.equal(policyDisplay.outputs.model, "gpt-5.5");
  assert.equal(policyDisplay.outputs.reasoning_effort, "");
});

test("provider resolver lets route model policy override provider defaults", () => {
  const resolved = runResolver({
    DEFAULT_PROVIDER: "codex",
    OPENAI_API_KEY: "openai-token",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
    AGENT_MODEL_POLICY: JSON.stringify({
      providers: {
        codex: { model: "gpt-5.4", reasoning_effort: "xhigh" },
        claude: { model: "claude-sonnet-4-5", reasoning_effort: "max" },
      },
      route_overrides: {
        "test-route": { provider: "claude", model: "claude-haiku-4-5", reasoning_effort: "medium" },
      },
    }),
  });

  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.outputs.provider, "claude");
  assert.equal(resolved.outputs.reason, "AGENT_MODEL_POLICY route override for test-route");
  assert.equal(resolved.outputs.model, "claude-haiku-4-5");
  assert.equal(resolved.outputs.reasoning_effort, "medium");
});

test("provider resolver keeps inline route provider from inheriting route policy settings", () => {
  const resolved = runResolver({
    ROUTE_PROVIDER: "codex",
    OPENAI_API_KEY: "openai-token",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
    AGENT_MODEL_POLICY: JSON.stringify({
      providers: {
        codex: { model: "gpt-5.4", reasoning_effort: "xhigh" },
        claude: { model: "claude-sonnet-4-5", reasoning_effort: "max" },
      },
      route_overrides: {
        "test-route": { provider: "claude", model: "claude-haiku-4-5", reasoning_effort: "medium" },
      },
    }),
  });

  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.outputs.provider, "codex");
  assert.equal(resolved.outputs.reason, "route override for test-route");
  assert.equal(resolved.outputs.model, "gpt-5.4");
  assert.equal(resolved.outputs.reasoning_effort, "xhigh");
});

test("provider resolver rejects model policy default provider", () => {
  const resolved = runResolver({
    OPENAI_API_KEY: "openai-token",
    AGENT_MODEL_POLICY: JSON.stringify({
      default: { provider: "claude" },
    }),
  });

  assert.notEqual(resolved.status, 0);
  assert.match(resolved.stderr, /default\.provider is not supported; use AGENT_DEFAULT_PROVIDER/);
});

test("provider resolver rejects non-string model policy token values", () => {
  const cases = [
    {
      name: "numeric model",
      policy: { default: { model: 123 } },
      error: /default\.model must be a string/,
    },
    {
      name: "boolean model",
      policy: { providers: { codex: { model: false } } },
      error: /providers\.codex\.model must be a string/,
    },
    {
      name: "numeric reasoning effort",
      policy: { default: { reasoning_effort: 123 } },
      error: /default\.reasoning_effort must be a string/,
    },
    {
      name: "boolean reasoning effort",
      policy: {
        route_overrides: {
          "test-route": { reasoning_effort: true },
        },
      },
      error: /route_overrides\.test-route\.reasoning_effort must be a string/,
    },
  ];

  for (const { name, policy, error } of cases) {
    const resolved = runResolver({
      OPENAI_API_KEY: "openai-token",
      AGENT_MODEL_POLICY: JSON.stringify(policy),
    });

    assert.notEqual(resolved.status, 0, name);
    assert.match(resolved.stderr, error, name);
  }
});

test("provider resolver preserves null and empty model policy token handling", () => {
  const resolved = runResolver({
    OPENAI_API_KEY: "openai-token",
    AGENT_MODEL_POLICY: JSON.stringify({
      providers: {
        codex: { model: "gpt-5.4", reasoning_effort: "xhigh" },
      },
      route_overrides: {
        "test-route": { model: "", reasoning_effort: null },
      },
    }),
  });

  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.outputs.provider, "codex");
  assert.equal(resolved.outputs.model, "");
  assert.equal(resolved.outputs.reasoning_effort, "xhigh");
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

  const invalidPolicy = runResolver({
    OPENAI_API_KEY: "openai-token",
    AGENT_MODEL_POLICY: '{"route_overrides": []}',
  });

  assert.notEqual(invalidPolicy.status, 0);
  assert.match(invalidPolicy.stderr, /route_overrides must be an object/);
});
