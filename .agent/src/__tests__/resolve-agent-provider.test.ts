import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
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
  | "AGENT_MODEL_POLICY"
  | "MODEL_REGISTRY_URL"
  | "MODEL_REGISTRY_TIMEOUT_MS",
  string
>>;

async function withRegistryServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  fn: (url: string) => Promise<void> | void,
) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}/model-defaults.json`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

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
        MODEL_REGISTRY_URL: "http://127.0.0.1:1/model-defaults.json",
        MODEL_REGISTRY_TIMEOUT_MS: "25",
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

async function runResolverAsync(env: ResolverEnv = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-provider-"));
  const outputFile = path.join(tempDir, "github-output");

  try {
    const result = await new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [resolverScript], {
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
          MODEL_REGISTRY_URL: "http://127.0.0.1:1/model-defaults.json",
          MODEL_REGISTRY_TIMEOUT_MS: "25",
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        resolve({ status, stdout, stderr });
      });
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
  assert.equal(codex.outputs.model_source, "bundled");
  assert.equal(codex.outputs.reasoning_effort, "");

  const claude = runResolver({
    DEFAULT_PROVIDER: "claude",
  });

  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(claude.outputs.provider, "claude");
  assert.equal(claude.outputs.model, "claude-opus-4-8");
  assert.equal(claude.outputs.model_source, "bundled");
  assert.equal(claude.outputs.reasoning_effort, "");
});

test("provider resolver applies a valid remote model registry above bundled defaults", async () => {
  await withRegistryServer((_, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      version: 1,
      providers: {
        codex: { default: { model: "gpt-remote" } },
        claude: { default: { model: "claude-remote" } },
      },
    }));
  }, async (url) => {
    const resolved = await runResolverAsync({
      DEFAULT_PROVIDER: "codex",
      MODEL_REGISTRY_URL: url,
    });

    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.outputs.provider, "codex");
    assert.equal(resolved.outputs.model, "gpt-remote");
    assert.equal(resolved.outputs.model_source, "remote");
  });
});

test("provider resolver reports bundled source for providers missing from remote registry", async () => {
  await withRegistryServer((_, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      version: 1,
      providers: {
        codex: { default: { model: "gpt-remote" } },
      },
    }));
  }, async (url) => {
    const resolved = await runResolverAsync({
      DEFAULT_PROVIDER: "claude",
      MODEL_REGISTRY_URL: url,
    });

    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.outputs.provider, "claude");
    assert.equal(resolved.outputs.model, "claude-opus-4-8");
    assert.equal(resolved.outputs.model_source, "bundled");
  });
});

test("provider resolver falls back to bundled defaults after remote timeout", async () => {
  await withRegistryServer(() => {
    // Leave the response open so the resolver timeout path is exercised.
  }, async (url) => {
    const resolved = await runResolverAsync({
      DEFAULT_PROVIDER: "claude",
      MODEL_REGISTRY_URL: url,
      MODEL_REGISTRY_TIMEOUT_MS: "25",
    });

    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.outputs.provider, "claude");
    assert.equal(resolved.outputs.model, "claude-opus-4-8");
    assert.equal(resolved.outputs.model_source, "bundled");
    assert.match(resolved.stderr, /falling back to bundled defaults/);
  });
});

test("provider resolver falls back to bundled defaults for invalid remote registries", async () => {
  await withRegistryServer((_, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      version: 1,
      providers: {
        other: { default: { model: "bad-model" } },
      },
    }));
  }, async (url) => {
    const fallback = await runResolverAsync({
      DEFAULT_PROVIDER: "codex",
      MODEL_REGISTRY_URL: url,
    });

    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(fallback.outputs.model, "gpt-5.5");
    assert.equal(fallback.outputs.model_source, "bundled");
    assert.match(fallback.stderr, /falling back to bundled defaults/);
  });
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
  assert.equal(resolved.outputs.model_source, "policy");
  assert.equal(resolved.outputs.reasoning_effort, "max");
  assert.match(resolved.stderr, /relying on local Claude authentication/);
});

test("provider resolver keeps AGENT_MODEL_POLICY above remote registry defaults", async () => {
  await withRegistryServer((_, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      version: 1,
      providers: {
        codex: { default: { model: "gpt-remote" } },
      },
    }));
  }, async (url) => {
    const resolved = await runResolverAsync({
      DEFAULT_PROVIDER: "codex",
      MODEL_REGISTRY_URL: url,
      AGENT_MODEL_POLICY: JSON.stringify({
        providers: {
          codex: { model: "gpt-policy", reasoning_effort: "xhigh" },
        },
      }),
    });

    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.outputs.provider, "codex");
    assert.equal(resolved.outputs.model, "gpt-policy");
    assert.equal(resolved.outputs.model_source, "policy");
    assert.equal(resolved.outputs.reasoning_effort, "xhigh");
  });
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
  assert.equal(policyDisplay.outputs.model_source, "bundled");
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
  assert.equal(resolved.outputs.model_source, "");
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
