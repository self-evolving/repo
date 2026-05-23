#!/usr/bin/env node

const fs = require("node:fs");

const VALID_PROVIDERS = new Set(["auto", "codex", "claude"]);
const VALID_ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function providerField(value, label, { allowEmpty = false } = {}) {
  const provider = normalizeProvider(value);
  if (!provider && allowEmpty) return "";
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(`${label} must be auto, codex, or claude`);
  }
  return provider;
}

function outputValue(value, label) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return "";
  if (/[\r\n]/.test(text)) {
    throw new Error(`${label} must not contain newlines`);
  }
  return text;
}

function readConfig(value, label, { allowProvider }) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  const config = {};
  if (allowProvider && Object.prototype.hasOwnProperty.call(value, "provider")) {
    const provider = providerField(value.provider, `${label}.provider`, { allowEmpty: true });
    if (provider) config.provider = provider;
  }
  if (Object.prototype.hasOwnProperty.call(value, "model")) {
    config.model = outputValue(value.model, `${label}.model`) || "";
  }
  if (Object.prototype.hasOwnProperty.call(value, "reasoning_effort")) {
    const effort = outputValue(value.reasoning_effort, `${label}.reasoning_effort`);
    if (effort) config.reasoningEffort = effort;
  }
  return config;
}

function parsePolicy(raw) {
  const policy = { defaultConfig: {}, providers: {}, routeOverrides: {} };
  const text = String(raw || "").trim();
  if (!text) return policy;

  const payload = JSON.parse(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("AGENT_MODEL_POLICY must be a JSON object");
  }

  if (Object.prototype.hasOwnProperty.call(payload, "default")) {
    policy.defaultConfig = readConfig(payload.default, "default", { allowProvider: true });
  }

  if (Object.prototype.hasOwnProperty.call(payload, "providers")) {
    if (!payload.providers || typeof payload.providers !== "object" || Array.isArray(payload.providers)) {
      throw new Error("providers must be an object");
    }
    for (const [rawProvider, rawConfig] of Object.entries(payload.providers)) {
      const provider = normalizeProvider(rawProvider);
      if (provider !== "codex" && provider !== "claude") {
        throw new Error(`Invalid provider key in model policy: ${provider || "missing"}`);
      }
      policy.providers[provider] = readConfig(rawConfig, `providers.${provider}`, { allowProvider: false });
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, "route_overrides")) {
    if (!payload.route_overrides || typeof payload.route_overrides !== "object" || Array.isArray(payload.route_overrides)) {
      throw new Error("route_overrides must be an object");
    }
    for (const [rawRoute, rawConfig] of Object.entries(payload.route_overrides)) {
      const route = String(rawRoute || "").trim().toLowerCase();
      if (!VALID_ROUTE_KEY.test(route)) {
        throw new Error(`Invalid route override key in model policy: ${route || "missing"}`);
      }
      policy.routeOverrides[route] = readConfig(rawConfig, `route_overrides.${route}`, { allowProvider: true });
    }
  }

  return policy;
}

function setOutput(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

function writeOutputs({ provider, reason, model = "", reasoningEffort = "" }) {
  setOutput("provider", provider);
  setOutput("reason", reason);
  setOutput("install_codex", provider === "codex" ? "true" : "false");
  setOutput("install_claude", provider === "claude" ? "true" : "false");
  setOutput("model", model);
  setOutput("reasoning_effort", reasoningEffort);
}

function firstProviderChoice(choices) {
  return choices.find((choice) => choice.provider) || { provider: "auto", reason: "AGENT_DEFAULT_PROVIDER" };
}

function applyRunConfig(target, config) {
  if (Object.prototype.hasOwnProperty.call(config, "model")) {
    target.model = config.model || "";
  }
  if (config.reasoningEffort) {
    target.reasoningEffort = config.reasoningEffort;
  }
}

function resolveRunConfig(policy, provider, route, { routeProvider }) {
  const config = { model: "", reasoningEffort: "" };
  applyRunConfig(config, policy.defaultConfig);
  applyRunConfig(config, policy.providers[provider] || {});
  if (!routeProvider) {
    applyRunConfig(config, policy.routeOverrides[route] || {});
  }
  return config;
}

function resolveProvider(env, policy, route) {
  const readInputProvider = (value) => {
    const provider = normalizeProvider(value);
    if (!provider) return "";
    if (!VALID_PROVIDERS.has(provider)) {
      throw new Error(`Invalid agent provider '${provider}' for route '${route}'. Use auto, codex, or claude.`);
    }
    return provider;
  };
  const routeProvider = readInputProvider(env.ROUTE_PROVIDER || "");
  const defaultProvider = readInputProvider(env.DEFAULT_PROVIDER || "auto") || "auto";
  const routeConfig = policy.routeOverrides[route] || {};

  return {
    routeProvider,
    ...firstProviderChoice([
      { provider: routeProvider, reason: `route override for ${route}` },
      {
        provider: routeConfig.provider || "",
        reason: `AGENT_MODEL_POLICY route override for ${route}`,
      },
      { provider: policy.defaultConfig.provider || "", reason: "AGENT_MODEL_POLICY default" },
      { provider: defaultProvider, reason: "AGENT_DEFAULT_PROVIDER" },
    ]),
  };
}

function main(env) {
  const route = String(env.ROUTE || "").trim().toLowerCase();
  const required = normalizeProvider(env.REQUIRED || "true");
  if (required !== "true" && required !== "false") {
    throw new Error(`Invalid required flag '${required}' for route '${route}'. Use true or false.`);
  }

  const policy = parsePolicy(env.AGENT_MODEL_POLICY || "");
  const requested = resolveProvider(env, policy, route);

  const hasCodex = Boolean(env.OPENAI_API_KEY);
  const hasClaudeOauth = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN);
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
  const hasClaude = hasClaudeOauth || hasAnthropic;
  const claudeReason = hasClaudeOauth
    ? "CLAUDE_CODE_OAUTH_TOKEN is configured"
    : hasAnthropic
      ? "ANTHROPIC_API_KEY is configured"
      : "";

  let provider = "";
  let reason = "";
  if (requested.provider !== "auto") {
    provider = requested.provider;
    reason = requested.reason;
  } else if (hasCodex) {
    provider = "codex";
    reason = "OPENAI_API_KEY is configured";
  } else if (hasClaude) {
    provider = "claude";
    reason = claudeReason;
  } else {
    console.error(
      `No configured agent provider for route '${route}'. Set AGENT_DEFAULT_PROVIDER to codex or claude, configure AGENT_MODEL_POLICY.default.provider, or configure OPENAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY.`,
    );
    if (required === "true") return 1;
    writeOutputs({ provider: "", reason: "no configured provider" });
    console.log(`Agent provider for ${route} is unresolved (no configured provider).`);
    return 0;
  }

  if (requested.provider !== "auto" && provider === "codex" && !hasCodex) {
    console.error(
      `Resolved provider codex for route '${route}' without OPENAI_API_KEY; relying on local Codex authentication if available.`,
    );
  }
  if (requested.provider !== "auto" && provider === "claude" && !hasClaude) {
    console.error(
      `Resolved provider claude for route '${route}' without CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY; relying on local Claude authentication if available.`,
    );
  }

  const runConfig = resolveRunConfig(policy, provider, route, { routeProvider: requested.routeProvider });
  writeOutputs({ provider, reason, model: runConfig.model, reasoningEffort: runConfig.reasoningEffort });
  console.log(`Resolved agent provider for ${route}: ${provider} (${reason}).`);
  if (runConfig.model) {
    console.log(`Resolved agent model for ${route}: ${runConfig.model}.`);
  }
  return 0;
}

try {
  process.exitCode = main(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
