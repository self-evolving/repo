#!/usr/bin/env node

const fs = require("node:fs");

const VALID_PROVIDERS = new Set(["auto", "codex", "claude"]);
const VALID_ROUTE_KEY = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function validateProvider(value) {
  return VALID_PROVIDERS.has(value);
}

function setOutput(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

function normalizeOptionalToken(value, label) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) return "";
  if (!SAFE_TOKEN.test(normalized)) {
    throw new Error(`${label} must be a non-empty token without whitespace or control characters`);
  }
  return normalized;
}

function normalizeOptionalProvider(value, label) {
  const normalized = normalizeProvider(value);
  if (!normalized || !validateProvider(normalized)) {
    throw new Error(`${label} must be auto, codex, or claude`);
  }
  return normalized;
}

function normalizeConfig(value, label, allowProvider) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  const config = {};
  if (allowProvider && Object.prototype.hasOwnProperty.call(value, "provider")) {
    config.provider = normalizeOptionalProvider(value.provider, `${label}.provider`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "model")) {
    config.model = normalizeOptionalToken(value.model, `${label}.model`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "reasoning_effort")) {
    const reasoningEffort = normalizeOptionalToken(
      value.reasoning_effort,
      `${label}.reasoning_effort`,
    );
    if (reasoningEffort) config.reasoningEffort = reasoningEffort;
  }
  return config;
}

function parsePolicy(raw) {
  const text = String(raw || "").trim();
  const empty = {
    defaultConfig: {},
    providers: {},
    routeOverrides: {},
  };
  if (!text) return empty;

  const payload = JSON.parse(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("AGENT_MODEL_POLICY must be a JSON object");
  }

  const policy = { ...empty };
  if (Object.prototype.hasOwnProperty.call(payload, "default")) {
    if (
      payload.default &&
      typeof payload.default === "object" &&
      !Array.isArray(payload.default) &&
      Object.prototype.hasOwnProperty.call(payload.default, "provider")
    ) {
      throw new Error("default.provider is not supported; use AGENT_DEFAULT_PROVIDER");
    }
    policy.defaultConfig = normalizeConfig(payload.default, "default", false);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "providers")) {
    const providers = payload.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      throw new Error("providers must be an object");
    }
    for (const [provider, config] of Object.entries(providers)) {
      const normalizedProvider = normalizeProvider(provider);
      if (normalizedProvider !== "codex" && normalizedProvider !== "claude") {
        throw new Error(`Invalid provider key in model policy: ${normalizedProvider || "missing"}`);
      }
      policy.providers[normalizedProvider] = normalizeConfig(
        config,
        `providers.${normalizedProvider}`,
        false,
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "route_overrides")) {
    const routeOverrides = payload.route_overrides;
    if (!routeOverrides || typeof routeOverrides !== "object" || Array.isArray(routeOverrides)) {
      throw new Error("route_overrides must be an object");
    }
    for (const [route, config] of Object.entries(routeOverrides)) {
      const normalizedRoute = String(route || "").trim().toLowerCase();
      if (!VALID_ROUTE_KEY.test(normalizedRoute)) {
        throw new Error(`Invalid route override key in model policy: ${normalizedRoute || "missing"}`);
      }
      policy.routeOverrides[normalizedRoute] = normalizeConfig(
        config,
        `route_overrides.${normalizedRoute}`,
        true,
      );
    }
  }
  return policy;
}

function applyRunConfig(target, config) {
  if (Object.prototype.hasOwnProperty.call(config, "model")) {
    target.model = config.model || "";
  }
  if (config.reasoningEffort) {
    target.reasoningEffort = config.reasoningEffort;
  }
}

function resolveProviderRequest(env, policy, route) {
  const routeProvider = normalizeProvider(env.ROUTE_PROVIDER || "");
  const defaultProvider = normalizeProvider(env.DEFAULT_PROVIDER || "auto") || "auto";

  for (const candidate of [routeProvider, defaultProvider]) {
    if (candidate && !validateProvider(candidate)) {
      throw new Error(`Invalid agent provider '${candidate}' for route '${route}'. Use auto, codex, or claude.`);
    }
  }

  let requestedProvider = defaultProvider;
  let requestedReason = "AGENT_DEFAULT_PROVIDER";

  const routeConfig = policy.routeOverrides[route];
  if (routeConfig?.provider) {
    requestedProvider = routeConfig.provider;
    requestedReason = `AGENT_MODEL_POLICY route override for ${route}`;
  }

  if (routeProvider) {
    requestedProvider = routeProvider;
    requestedReason = `route override for ${route}`;
  }

  return { requestedProvider, requestedReason, hasRouteProviderOverride: Boolean(routeProvider) };
}

function resolveRunConfig(policy, provider, route, options = {}) {
  const config = { model: "", reasoningEffort: "" };
  applyRunConfig(config, policy.defaultConfig);
  applyRunConfig(config, policy.providers[provider] || {});
  if (!options.hasRouteProviderOverride) {
    applyRunConfig(config, policy.routeOverrides[route] || {});
  }
  return config;
}

function writeOutputs({ provider, reason, model, reasoningEffort }) {
  setOutput("provider", provider);
  setOutput("reason", reason);
  setOutput("install_codex", provider === "codex" ? "true" : "false");
  setOutput("install_claude", provider === "claude" ? "true" : "false");
  setOutput("model", model);
  setOutput("reasoning_effort", reasoningEffort);
}

function main(env) {
  const route = String(env.ROUTE || "").trim().toLowerCase();
  const required = normalizeProvider(env.REQUIRED || "true");
  if (required !== "true" && required !== "false") {
    throw new Error(`Invalid required flag '${required}' for route '${route}'. Use true or false.`);
  }

  const policy = parsePolicy(env.AGENT_MODEL_POLICY || "");
  const { requestedProvider, requestedReason, hasRouteProviderOverride } = resolveProviderRequest(env, policy, route);

  const hasCodex = Boolean(env.OPENAI_API_KEY);
  const hasClaudeOauth = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN);
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
  const hasClaude = hasClaudeOauth || hasAnthropic;
  const claudeReason = hasClaudeOauth
    ? "CLAUDE_CODE_OAUTH_TOKEN is configured"
    : hasAnthropic
      ? "ANTHROPIC_API_KEY is configured"
      : "";
  const explicitProvider = requestedProvider !== "auto";

  let provider = "";
  let reason = "";
  if (explicitProvider) {
    provider = requestedProvider;
    reason = requestedReason;
  } else if (hasCodex) {
    provider = "codex";
    reason = "OPENAI_API_KEY is configured";
  } else if (hasClaude) {
    provider = "claude";
    reason = claudeReason;
  } else {
    console.error(
      `No configured agent provider for route '${route}'. Set AGENT_DEFAULT_PROVIDER to codex or claude, or configure OPENAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_API_KEY.`,
    );
    if (required === "true") {
      return 1;
    }
    writeOutputs({ provider: "", reason: "no configured provider", model: "", reasoningEffort: "" });
    console.log(`Agent provider for ${route} is unresolved (no configured provider).`);
    return 0;
  }

  if (explicitProvider && provider === "codex" && !hasCodex) {
    console.error(
      `Resolved provider codex for route '${route}' without OPENAI_API_KEY; relying on local Codex authentication if available.`,
    );
  }
  if (explicitProvider && provider === "claude" && !hasClaude) {
    console.error(
      `Resolved provider claude for route '${route}' without CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY; relying on local Claude authentication if available.`,
    );
  }

  const runConfig = resolveRunConfig(policy, provider, route, { hasRouteProviderOverride });
  writeOutputs({
    provider,
    reason,
    model: runConfig.model,
    reasoningEffort: runConfig.reasoningEffort,
  });
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
